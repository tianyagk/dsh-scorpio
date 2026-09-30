/**
 * 骰子判定引擎（纯函数，可自测）。
 *
 * 支持：
 *  - `NdM±K`：如 `1d100`、`2d6+3`、`3d6-1`；`d%` 视作 `d100`。
 *  - `N dM khX / klX`：取高 / 取低 X 个（`4d6kh3` 即经典「4d6 取高 3」）。
 *  - 命名检定：规则书 `skills` 里的一项，按 `attribute` 取属性修正。
 *  - 难度阶梯：rollUnder（骰值 ≤ 目标值成功）/ rollOver（骰值 ≥ 目标值成功）。
 *  - 对抗判定：双方各掷一次比大小（可用固定值代替骰式）。
 *  - 大成功 / 大失败区间。
 *
 * 随机源可注入（seeded 用于确定性自测），默认使用 node:crypto 的 randomInt。
 */
import { randomInt as cryptoRandomInt } from 'node:crypto'
import type {
  DiceSpec,
  DifficultyRung,
  RollOutcome,
  RollRequest,
  RollResult,
  RollSide,
  RulesSchema,
  CharacterBody,
  RulesSchema as Schema,
} from '../shared/model.ts'

/**
 * 随机源契约：**无参数、返回 [0, 1) 的比例值**。掷骰时按
 * `Math.floor(rng() * sides) + 1` 换算成骰面；注入自定义随机源（自测、复盘）
 * 时也遵守这个契约，`rngSource` 会把它标成 seeded。
 */
export type Rng = () => number

const MAX_TIMES = 100
const MAX_SIDES = 1000

/** 默认随机源：crypto.randomInt（无模偏）。 */
export function osRng(): number {
  return cryptoRandomInt(0, 1_000_000_000) / 1_000_000_000
}

/** 可复现的伪随机源（自测 / 复盘用）。 */
export function seededRng(seed: number): Rng {
  let state = (seed >>> 0) || 0x9e3779b9
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 4294967296
  }
}

/**
 * 解析骰式。
 * @throws Error 当骰式不合法（会原样返回给模型，模型可自行纠正）。
 */
export function parseDice(raw: string): DiceSpec {
  const input = String(raw ?? '').trim().toLowerCase().replace(/\s+/g, '')
  if (input === '') throw new Error('骰式不能为空')
  const match = /^(\d{0,3})d(%|\d{1,4})(?:(kh|kl)(\d{1,3}))?([+-]\d{1,4})?$/.exec(input)
  if (match === null) {
    throw new Error(`无法解析骰式「${raw}」：支持 NdM、NdM±K、NdM kh/kl X（如 1d100、2d6+3、4d6kh3）`)
  }
  const times = match[1] === '' ? 1 : Number(match[1])
  const sides = match[2] === '%' ? 100 : Number(match[2])
  const keepMode = match[3]
  const keepCount = match[4] === undefined ? undefined : Number(match[4])
  const modifier = match[5] === undefined ? 0 : Number(match[5])
  if (times < 1 || times > MAX_TIMES) throw new Error(`骰子个数必须在 1..${MAX_TIMES} 之间`)
  if (sides < 2 || sides > MAX_SIDES) throw new Error(`骰面数必须在 2..${MAX_SIDES} 之间`)
  let keep: DiceSpec['keep']
  if (keepMode !== undefined && keepCount !== undefined) {
    if (keepCount < 1 || keepCount > times) throw new Error(`kh/kl 的个数必须在 1..${times} 之间`)
    keep = { mode: keepMode as 'kh' | 'kl', count: keepCount }
  }
  const normalized =
    `${times}d${sides}` +
    (keep === undefined ? '' : `${keep.mode}${keep.count}`) +
    (modifier === 0 ? '' : modifier > 0 ? `+${modifier}` : `${modifier}`)
  return { raw: String(raw), times, sides, modifier, ...(keep === undefined ? {} : { keep }), normalized }
}

/** 掷一次骰式（不含难度判定）。 */
export function rollSpec(spec: DiceSpec, rng: Rng = osRng, poolTarget?: number): RollSide {
  const faces = Array.from({ length: spec.times }, () => ({
    sides: spec.sides,
    value: Math.min(spec.sides, Math.max(1, Math.floor(rng() * spec.sides) + 1)),
    kept: true,
  }))
  if (spec.keep !== undefined) {
    const order = [...faces].sort((a, b) =>
      spec.keep?.mode === 'kh' ? b.value - a.value : a.value - b.value,
    )
    const keepSet = new Set(order.slice(0, spec.keep.count))
    for (const face of faces) face.kept = keepSet.has(face)
  }
  const sum = faces.reduce((acc, face) => acc + (face.kept ? face.value : 0), 0)
  const side: RollSide = { name: 'roll', spec, faces, sum, modifier: spec.modifier, total: sum + spec.modifier }
  // 骰池风格：单个骰面 ≥ poolTarget 记一个成功，用成功数参与比较。
  if (poolTarget !== undefined) {
    side.successes = faces.reduce((acc, face) => acc + (face.kept && face.value >= poolTarget ? 1 : 0), 0)
    side.total = side.successes + spec.modifier
  }
  return side
}

/** 难度阶梯里命中的档位（按绝对值最接近的档位）。 */
export function difficultyLabel(ladder: readonly DifficultyRung[], value: number): string | undefined {
  if (!Array.isArray(ladder) || ladder.length === 0) return undefined
  let best: DifficultyRung | undefined
  for (const rung of ladder) {
    if (best === undefined || Math.abs(rung.value - value) < Math.abs(best.value - value)) best = rung
  }
  return best?.label
}

function inRange(value: number, range: { min?: number; max?: number } | undefined): boolean {
  if (range === undefined) return false
  const min = range.min ?? Number.NEGATIVE_INFINITY
  const max = range.max ?? Number.POSITIVE_INFINITY
  return value >= min && value <= max
}

/** 从规则 schema + 角色卡里取某个技能的检定基准。 */
export function checkBasis(
  schema: RulesSchema | undefined,
  sheet: CharacterBody | undefined,
  check: string | undefined,
): {
  id?: string
  label?: string
  attribute?: string
  attributeValue?: number
  skillValue?: number
  dice?: string
  difficulty?: number
} {
  if (check === undefined || check.trim() === '' || schema === undefined) return {}
  const needle = check.trim().toLowerCase()
  const skill = (schema.skills ?? []).find(
    (item) => item.id.toLowerCase() === needle || item.label.toLowerCase() === needle,
  )
  if (skill === undefined) return { id: check, label: check }
  const attrId = skill.attribute
  const attrValue =
    attrId === undefined
      ? undefined
      : numericOf(sheet?.attrs.find((attr) => attr.id === attrId)?.value)
  const skillValue = numericOf(sheet?.skills.find((entry) => entry.id === skill.id)?.value)
  return {
    id: skill.id,
    label: skill.label,
    ...(attrId === undefined ? {} : { attribute: attrId }),
    ...(attrValue === undefined ? {} : { attributeValue: attrValue }),
    ...(skillValue === undefined ? {} : { skillValue }),
    ...(skill.dice === undefined ? {} : { dice: skill.dice }),
    ...(skill.difficulty === undefined ? {} : { difficulty: skill.difficulty }),
  }
}

function numericOf(value: number | string | undefined): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  return undefined
}

/** 生成本次判定的 id（时间 + 随机后缀，无需外部依赖）。 */
function makeId(now: number, rng: Rng): string {
  const tail = Math.floor(rng() * 1_000_000).toString(36).padStart(4, '0')
  return `r${now.toString(36)}${tail}`
}

export interface RollContext {
  schema?: RulesSchema
  sheet?: CharacterBody
  rng?: Rng
  now?: number
}

/**
 * 执行一次判定：解析 → 掷骰 → 与难度或对手比较 → 产出可引用的结论。
 * 纯函数（`now`/`rng` 可注入），因此同一份流水可以被离线复算。
 */
export function performRoll(request: RollRequest, context: RollContext = {}): RollResult {
  const rng = context.rng ?? osRng
  const now = context.now ?? Date.now()
  const schema = context.schema
  const sheet = context.sheet
  const basis = checkBasis(schema, sheet, request.check)

  const expression =
    (request.expression !== undefined && request.expression.trim() !== '' ? request.expression : undefined) ??
    basis.dice ??
    schema?.baseDice ??
    '1d100'
  const spec = parseDice(expression)
  const direction = schema?.direction ?? 'rollUnder'
  const modifier = Number.isFinite(request.modifier) ? Number(request.modifier) : 0

  const roll = rollSpec(spec, rng, schema?.poolTarget)
  // 行动者优先级：显式 actor（含 npc:xxx）> 玩家角色名 > 'player'。
  // 旧写法让 NPC 判定顶着玩家的名字，骰面与结论都会写错人。
  const actorLabel = request.actor !== undefined && request.actor !== '' ? request.actor : undefined
  roll.name =
    actorLabel !== undefined && actorLabel !== 'player'
      ? actorLabel
      : sheet?.name !== undefined && sheet.name !== ''
        ? sheet.name
        : (actorLabel ?? 'player')

  // 难度语义（与 schema 的 difficultyLadder 一致）：
  //   rollUnder：目标值 = 属性 + 技能 + 难度修正 + 临时修正
  //     —— 难度是「-50 近乎奇迹 … +40 显而易见」这样的**修正值**，缺省 0；
  //   rollOver ：目标值 = 难度（绝对阈值，缺省 schema.defaultDifficulty）− 临时修正
  //     —— 高骰成功系统里阶梯本身就是「要够到的数」，所以按绝对值解释。
  // 两种解释都只在 direction 上分叉，其余（属性/技能/大成功/大失败）共用。
  const attrPart = (basis.attributeValue ?? 0) + (basis.skillValue ?? 0)
  const rawDifficulty = request.difficulty ?? basis.difficulty
  const difficultyModifier =
    direction === 'rollUnder' ? (Number.isFinite(rawDifficulty) ? Number(rawDifficulty) : 0) : 0
  // 兜底目标值：只在"这次判定根本没有属性/技能基准"时使用（例如无规则书的裸骰）。
  // 绝不能用 `attrPart + modifier > 0` 这类符号判据——那会让属性 0 或负修正
  // 的角色反而拿到 50 的目标值（属性越低越强，与契约相反）。
  const hasBasis = basis.attributeValue !== undefined || basis.skillValue !== undefined
  const underBase = hasBasis
    ? 0
    : schema?.defaultDifficulty !== undefined && schema.defaultDifficulty > 0
      ? schema.defaultDifficulty
      : 50
  const rollOverTarget =
    direction === 'rollOver'
      ? Number.isFinite(rawDifficulty)
        ? Number(rawDifficulty)
        : (schema?.defaultDifficulty ?? 10)
      : 0
  const target =
    direction === 'rollUnder'
      ? hasBasis
        ? difficultyModifier + attrPart + modifier
        : underBase + difficultyModifier + modifier
      : rollOverTarget - modifier
  roll.target = target

  let opposed: RollSide | undefined
  let outcome: RollOutcome
  let success: boolean
  let margin: number | undefined
  let verdict: string

  const total = roll.total
  const critSuccess = inRange(total, schema?.critSuccess)
  const critFailure = inRange(total, schema?.critFailure)

  if (request.opposed !== undefined && request.opposed.name !== '') {
    const opposedName = request.opposed.name
    const opposedSpec =
      request.opposed.expression !== undefined && request.opposed.expression !== ''
        ? parseDice(request.opposed.expression)
        : spec
    const sided = rollSpec(opposedSpec, rng, schema?.poolTarget)
    sided.name = opposedName
    /**
     * 对手的**目标值**：显式给 `value` 时用它（理解为对手的技能/属性值），
     * 否则与玩家同目标（纯比骰运）。注意 `value` 不再是"对手已掷出的点数"——
     * 那样写会让双方余量随同一目标值平移，属性在对抗里被完全抵消。
     */
    const opponentTarget =
      typeof request.opposed.value === 'number' && Number.isFinite(request.opposed.value)
        ? request.opposed.value
        : target
    sided.target = opponentTarget
    opposed = sided
    /**
     * 对抗比的是「相对各自目标值的余量」，不是裸骰值——否则属性与技能完全不参与
     * 对抗（旧实现里 dex=0 与 dex=90 的结果一模一样），而工具描述承诺
     * 「check 按规则书技能表取属性修正」。固定值对手按"它已经掷出这个数"处理，
     * 目标值沿用同一难度。
     */
    const marginOf = (side: RollSide, sideTarget: number): number =>
      direction === 'rollUnder' ? sideTarget - side.total : side.total - sideTarget
    const playerMargin = marginOf(roll, target)
    const oppMargin = marginOf(sided, opponentTarget)
    margin = playerMargin - oppMargin
    if (playerMargin > oppMargin) {
      success = !critFailure
      outcome = critFailure ? 'critical-failure' : critSuccess ? 'critical-success' : 'success'
    } else if (playerMargin < oppMargin) {
      success = critSuccess
      outcome = critSuccess ? 'critical-success' : critFailure ? 'critical-failure' : 'failure'
    } else {
      outcome = 'tie'
      success = false
    }
    const tieRule = schema?.opposedTie ?? 'gm'
    const face = `${roll.name} ${total}/${target}（余量 ${playerMargin}）vs ${opposedName} ${sided.total}/${opponentTarget}（余量 ${oppMargin}）`
    verdict =
      outcome === 'tie'
        ? tieRule === 'defender'
          ? `对抗平手（${face}）——按规则书，守方维持现状，发起者的行动未达成`
          : tieRule === 'reroll'
            ? `对抗平手（${face}）——按规则书需要重掷或进入下一轮`
            : `对抗平手（${face}）——由主持按剧情裁定僵持结果`
        : `${face}：${success ? '胜出，行动达成' : '落败，行动被压制'}（余量差 ${margin}）`
  } else if (direction === 'rollUnder') {
    success = total <= target
    margin = target - total
    if (critSuccess && success) outcome = 'critical-success'
    else if (critFailure && !success) outcome = 'critical-failure'
    else outcome = success ? 'success' : 'failure'
    verdict =
      outcome === 'critical-success'
        ? `大成功（${total} ≤ ${target}）：超出预期的成功，可给出额外收益`
        : outcome === 'critical-failure'
          ? `大失败（${total} > ${target}）：不仅失败，还应引入额外代价`
          : success
            ? `成功（${total} ≤ ${target}，余量 ${margin}）`
            : `失败（${total} > ${target}，差 ${Math.abs(margin ?? 0)}）`
  } else {
    success = total >= target
    margin = total - target
    if (critSuccess && success) outcome = 'critical-success'
    else if (critFailure && !success) outcome = 'critical-failure'
    else outcome = success ? 'success' : 'failure'
    verdict =
      outcome === 'critical-success'
        ? `大成功（${total} ≥ ${target}）：超出预期的成功，可给出额外收益`
        : outcome === 'critical-failure'
          ? `大失败（${total} < ${target}）：不仅失败，还应引入额外代价`
          : success
            ? `成功（${total} ≥ ${target}，余量 ${margin}）`
            : `失败（${total} < ${target}，差 ${Math.abs(margin ?? 0)}）`
  }

  // 阶梯标签按「难度修正」匹配（rollUnder），rollOver 按绝对阈值匹配。
  const ladderKey = direction === 'rollUnder' ? difficultyModifier : rollOverTarget
  const label = difficultyLabel(schema?.difficultyLadder ?? [], ladderKey)

  const result: RollResult = {
    id: makeId(now, rng),
    ts: now,
    ...(request.actor === undefined ? {} : { actor: request.actor }),
    ...(request.action === undefined ? {} : { action: request.action }),
    ...(request.reason === undefined ? {} : { reason: request.reason }),
    ...(basis.id === undefined
      ? {}
      : {
          check: {
            id: basis.id,
            label: basis.label ?? basis.id,
            ...(basis.attribute === undefined ? {} : { attribute: basis.attribute }),
            ...(basis.attributeValue === undefined ? {} : { attributeValue: basis.attributeValue }),
            ...(basis.skillValue === undefined ? {} : { skillValue: basis.skillValue }),
          },
        }),
    direction,
    roll,
    ...(opposed === undefined ? {} : { opposed }),
    outcome,
    success,
    ...(label === undefined ? {} : { difficultyLabel: label }),
    ...(margin === undefined ? {} : { margin }),
    verdict,
    rngSource: context.rng === undefined ? 'os' : 'seeded',
  }
  return result
}

/** 结果 → 给模型看的一行摘要（工具 render 用）。 */
export function renderRoll(result: RollResult): string {
  const faces = result.roll.faces.map((face) => (face.kept ? `${face.value}` : `(${face.value})`)).join(' ')
  const head =
    `🎲 ${result.check !== undefined ? `${result.check.label}` : '通用判定'}` +
    `${result.action === undefined ? '' : ` · ${result.action}`}` +
    `｜骰式 ${result.roll.spec.normalized} → [${faces}]` +
    `${result.roll.successes === undefined ? '' : ` → 成功数 ${result.roll.successes}`}` +
    `${result.roll.modifier === 0 ? '' : ` 修正 ${result.roll.modifier > 0 ? '+' : ''}${result.roll.modifier}`}` +
    ` = ${result.roll.total}` +
    `${result.roll.target === undefined ? '' : `（目标 ${result.roll.target}）`}`
  const lines = [head]
  if (result.opposed !== undefined) {
    const oFaces = result.opposed.faces.map((face) => (face.kept ? `${face.value}` : `(${face.value})`)).join(' ')
    lines.push(
      `⚔️ 对抗 ${result.opposed.name}：${result.opposed.spec.normalized} → [${oFaces}] = ${result.opposed.total}` +
        `${result.opposed.target === undefined ? '' : `（目标 ${result.opposed.target}）`}`,
    )
  }
  lines.push(`结论：${result.verdict}`)
  if (result.difficultyLabel !== undefined) lines.push(`难度档：${result.difficultyLabel}`)
  lines.push(`流水号：${result.id}`)
  return lines.join('\n')
}

/** 规则 schema 的最小完整性校验（写规则书时用）。 */
export function normalizeSchema(input: unknown): RulesSchema {
  if (input === null || typeof input !== 'object') throw new Error('schema 必须是对象')
  const raw = input as Partial<RulesSchema>
  const baseDice = typeof raw.baseDice === 'string' && raw.baseDice !== '' ? raw.baseDice : '1d100'
  parseDice(baseDice) // 校验
  const direction = raw.direction === 'rollOver' ? 'rollOver' : 'rollUnder'
  const attributes = Array.isArray(raw.attributes)
    ? raw.attributes
        .filter((item) => item !== null && typeof item === 'object' && typeof item.id === 'string' && item.id !== '')
        .map((item) => ({
          id: String(item.id),
          label: typeof item.label === 'string' && item.label !== '' ? item.label : String(item.id),
          ...(typeof item.group === 'string' && item.group !== '' ? { group: item.group } : {}),
          ...(item.kind === undefined ? {} : { kind: item.kind }),
          ...(typeof item.min === 'number' ? { min: item.min } : {}),
          ...(typeof item.max === 'number' ? { max: item.max } : {}),
          ...(typeof item.base === 'number' ? { base: item.base } : {}),
          ...(typeof item.dice === 'string' && item.dice !== '' ? { dice: item.dice } : {}),
          ...(typeof item.desc === 'string' ? { desc: item.desc } : {}),
          ...(item.collapsed === true ? { collapsed: true } : {}),
        }))
    : []
  const skills = Array.isArray(raw.skills)
    ? raw.skills
        .filter((item) => item !== null && typeof item === 'object' && typeof item.id === 'string' && item.id !== '')
        .map((item) => ({
          id: String(item.id),
          label: typeof item.label === 'string' && item.label !== '' ? item.label : String(item.id),
          ...(typeof item.attribute === 'string' && item.attribute !== '' ? { attribute: item.attribute } : {}),
          ...(typeof item.dice === 'string' && item.dice !== '' ? { dice: item.dice } : {}),
          ...(typeof item.difficulty === 'number' ? { difficulty: item.difficulty } : {}),
          ...(Array.isArray(item.orAttributes)
            ? { orAttributes: item.orAttributes.filter((a: unknown) => typeof a === 'string') }
            : {}),
          ...(typeof item.desc === 'string' ? { desc: item.desc } : {}),
        }))
    : []
  const ladder: DifficultyRung[] = Array.isArray(raw.difficultyLadder)
    ? raw.difficultyLadder
        .filter((item) => item !== null && typeof item === 'object' && Number.isFinite(item.value))
        .map((item) => ({
          label: typeof item.label === 'string' && item.label !== '' ? item.label : String(item.value),
          value: Number(item.value),
          ...(typeof item.desc === 'string' ? { desc: item.desc } : {}),
        }))
        .sort((a, b) => a.value - b.value)
    : []
  // rollUnder 下 defaultDifficulty 只作为「未给难度时的默认修正」（一般为 0）；
  // rollOver 下它是未给难度时的回退阈值。
  const defaultDifficulty =
    Number.isFinite(raw.defaultDifficulty) && Number(raw.defaultDifficulty) >= 0
      ? Number(raw.defaultDifficulty)
      : direction === 'rollUnder'
        ? 0
        : 10
  return {
    version: 1,
    system: typeof raw.system === 'string' && raw.system !== '' ? raw.system : '未命名系统',
    ...(typeof raw.summary === 'string' && raw.summary !== '' ? { summary: raw.summary } : {}),
    baseDice,
    direction,
    difficultyLadder: ladder,
    defaultDifficulty,
    ...(raw.critSuccess === undefined ? {} : { critSuccess: raw.critSuccess }),
    ...(raw.critFailure === undefined ? {} : { critFailure: raw.critFailure }),
    attributes,
    skills,
    ...(raw.opposedTie === 'defender' || raw.opposedTie === 'reroll' || raw.opposedTie === 'gm'
      ? { opposedTie: raw.opposedTie }
      : {}),
    ...(typeof raw.statusSystem === 'string' && raw.statusSystem !== '' ? { statusSystem: raw.statusSystem } : {}),
    ...(typeof raw.adjudication === 'string' && raw.adjudication !== '' ? { adjudication: raw.adjudication } : {}),
    // 骰池系统：单个骰面 ≥ poolTarget 记一个成功。缺了它骰池会退化成「点数之和」。
    ...(typeof raw.poolTarget === 'number' && Number.isFinite(raw.poolTarget) ? { poolTarget: raw.poolTarget } : {}),
  }
}
