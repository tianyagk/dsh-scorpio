/**
 * 天蝎座（Scorpio）模型工具。
 *
 * 与其他工具插件不同，这里全部围绕**一次冒险的四元组**展开：
 *
 *   【世界书】 scorpio_worldbook —— 载入/查看/切换世界；同一世界可生成**多套规则书**
 *              （action=write_rulebook，style 选 d100 / d20 / d6pool / custom）；
 *   【模组集】 scorpio_module —— generate / list / read / select / remove / save
 *   【角色卡】 scorpio_character —— generate / list / select / get / update / save
 *   【判定】   scorpio_roll / scorpio_ledger
 *   【开局】   scorpio_run（四元组）+ scorpio_status（进度自检）
 *
 * 每个工具的第一跳都是同一件事：由 `exec.agent.id` 解析当前会话的工作区，并确认
 * 该会话确实跑在 Scorpio 预设上。四元组未齐备时，`scorpio_roll` 会拒绝判定，
 * 避免在还没确定规则与角色之前就开骰。
 */
import {
  DICE_PREFIX,
  MAX_EDIT_CHARS,
  PRESET_ID,
  RULE_STYLES,
  TOOL_CHARACTER,
  TOOL_LEDGER,
  TOOL_MODULE,
  TOOL_ROLL,
  TOOL_RUN,
  TOOL_STATUS,
  TOOL_WORLDBOOK,
  ruleStyleInfo,
  slugify,
  type CharacterBody,
  type CharacterPatch,
  type CharacterTemplate,
  type Module,
  type RollRequest,
  type RuleStyle,
  type Rulebook,
  type RulesSchema,
  type RunReport,
  type SlotEntry,
} from '../shared/model.ts'
import { performRoll, renderRoll } from './dice.ts'
import { blankBody, ScorpioStore } from './store.ts'
import { resolveSessionPreset, scanWorldbook } from './worldbook.ts'
import { log, type PluginContext, type PluginToolDefinition } from './context.ts'

const text = (value: string): Array<{ type: 'text'; text: string }> => [{ type: 'text', text: value }]

export interface ToolDeps {
  ctx: PluginContext
  storeFor(workspace: string): ScorpioStore
}

interface Resolved {
  sessionId: string
  cwd: string
  store: ScorpioStore
}

/** 解析「调用者会话 → 工作区 → store」，并强制 Scorpio 预设。 */
async function resolveCaller(
  deps: ToolDeps,
  exec: { agent?: { id?: string }; signal?: AbortSignal } | undefined,
): Promise<Resolved> {
  const agents = deps.ctx.get('agents') as { currentInitiator?(): { id?: string } | undefined } | undefined
  const sessionId = exec?.agent?.id ?? agents?.currentInitiator?.()?.id
  if (typeof sessionId !== 'string' || sessionId === '') {
    throw new Error('无法确定当前会话（缺少 session id）')
  }
  const info = await resolveSessionPreset(deps.ctx, sessionId)
  if (info.preset !== PRESET_ID) {
    throw new Error(
      `本工具只在「天蝎座 Scorpio」预设下可用，当前会话的预设是「${info.preset ?? '未知'}」。` +
        '请新建一个使用 Scorpio 预设的会话。',
    )
  }
  if (typeof info.cwd !== 'string' || info.cwd === '') {
    throw new Error('当前会话没有工作区（cwd），请先为会话选择工作目录')
  }
  return { sessionId, cwd: info.cwd, store: deps.storeFor(info.cwd) }
}

/**
 * 产物落盘路径的职责边界（与 routes.ts 的 artifactRel 同规则）：
 * 拒绝 `.scorpio/`、拒绝 `..`/绝对路径、要求 `.md`、拒绝落在任何世界书目录内。
 */
async function artifactRel(
  resolved: Resolved,
  worldId: string,
  rel: string,
  fallback: string,
): Promise<string> {
  const target = (rel.trim() === '' ? fallback : rel.trim()).replace(/\\+/g, '/').replace(/^\.\//, '')
  if (target.startsWith('.scorpio/') || target === '.scorpio') {
    throw new Error('产物不能写入 .scorpio/ 状态目录')
  }
  if (target.startsWith('/') || target.split('/').includes('..')) {
    throw new Error('产物路径不能是绝对路径、也不能包含 ..')
  }
  if (!/\.md$/i.test(target)) throw new Error('产物必须是 .md 文件')
  const current = await resolved.store.world(worldId)
  if (current !== undefined && current.path !== '') {
    if (target === current.path || target.startsWith(`${current.path}/`)) {
      throw new Error(`产物不能写入世界书目录 ${current.path}/（那是玩家的源资料）`)
    }
  }
  return target
}

/** 取当前世界：优先会话绑定，其次该工作区唯一的那一本。 */
async function requireWorld(
  resolved: Resolved,
  explicit?: string,
): Promise<{ worldId: string; world: NonNullable<Awaited<ReturnType<ScorpioStore['world']>>> }> {
  const binding = await resolved.store.binding(resolved.sessionId)
  const worldId = explicit !== undefined && explicit !== '' ? explicit : binding.worldId
  const worlds = await resolved.store.worlds()
  const pickId = worldId ?? (worlds.length === 1 ? worlds[0]?.id : undefined)
  if (pickId === undefined) {
    throw new Error(
      worlds.length === 0
        ? `本工作区还没有世界书：先调用 ${TOOL_WORLDBOOK} action=load path=<工作区内的目录>`
        : `本工作区有多本世界书，请指定 worldId（现有：${worlds.map((item) => item.id).join('、')}）`,
    )
  }
  const world = await resolved.store.world(pickId)
  if (world === undefined) throw new Error(`世界书不存在：${pickId}`)
  return { worldId: world.id, world }
}

/** 取当前规则书：优先会话绑定，其次该世界的第一套。 */
async function requireRulebook(
  resolved: Resolved,
  worldId: string,
): Promise<Rulebook> {
  const binding = await resolved.store.binding(resolved.sessionId)
  const rules = await resolved.store.rulesOf(worldId)
  if (rules.length === 0) {
    throw new Error(
      '这个世界还没有规则书：调用 scorpio_worldbook action=write_rulebook 写一套' +
        '（style 可选 d100 / d20 / d6pool / custom）',
    )
  }
  const pick =
    (binding.rulebookId === undefined ? undefined : rules.find((item) => item.id === binding.rulebookId)) ??
    rules[0]
  if (pick === undefined) throw new Error('规则书解析失败')
  return pick
}

/** 把模组正文渲染成给模型读的文本。 */
function renderModuleBody(module: Module, markdown: string): string {
  const head = `【模组】${module.name}${module.scale === undefined ? '' : `（${module.scale}）`}\n${module.tagline}`
  return `${head}\n路径：${module.mdPath}\n\n${markdown}`
}

/** 角色卡池的一行摘要。 */
function templateLine(template: CharacterTemplate, showAll = false): string {
  const attrs = template.attrs
    .filter((item) => showAll || item.value !== '' )
    .slice(0, 8)
    .map((item) => `${item.id}=${item.value}${item.pending === true ? '(待确认)' : ''}`)
    .join('、')
  const slots = template.slots.filter((slot) => slot.kind === 'item' && slot.name !== '').length
  return (
    `· ${template.id}｜${template.name || '（未命名）'}${template.concept === undefined ? '' : `｜${template.concept}`}` +
    `${template.rulebookId === undefined ? '' : `｜规则 ${template.rulebookId}`}` +
    `${template.moduleId === undefined ? '' : `｜模组 ${template.moduleId}`}` +
    `${template.generated === true ? '｜模型生成' : ''}\n    属性：${attrs || '（空）'}${slots > 0 ? `｜物品 ${slots} 件` : ''}`
  )
}

/** 四元组进度的一行摘要（status 与 run 共用）。 */
function runLine(run: RunReport): string {
  const marks: Record<string, string> = {}
  marks.world = run.world === undefined ? '· 世界书' : `✓ 世界书（${run.world.name}）`
  marks.rulebook =
    run.rulebook === undefined ? '· 规则书' : `✓ 规则书（${run.rulebook.title} / ${run.rulebook.style}）`
  marks.module = run.module === undefined ? '· 模组' : `✓ 模组（${run.module.name}）`
  marks.character =
    run.character === undefined ? '· 角色卡' : `✓ 角色卡（${run.character.name}）`
  return [marks.world, marks.rulebook, marks.module, marks.character].join(' → ')
}

export function makeAgentTools(deps: ToolDeps): {
  registerTools: (
    tools: { register(def: PluginToolDefinition): () => void },
    prompt: { section(opts: { name: string; order: number; text: () => string }): () => void } | undefined,
  ) => () => void
} {
  const defs: PluginToolDefinition[] = []

  // ── 1. 世界书 + 规则书（规则书是世界书的子项） ─────────────────────────────
  defs.push({
    name: TOOL_WORLDBOOK,
    description:
      '【世界书】世界观资料库，兼管它的规则书。action=load 载入工作区内某目录的全部文本（递归）并绑定到本会话；' +
      'action=list 看已载入的世界；action=read 取某本全文；action=bind 切换；action=find 关键词检索；action=remove 移除；' +
      'action=write_rulebook 为该世界写一套规则书（正文 + 机器可读 schema），同一世界可以有多套不同风格；' +
      'action=list_rules 看该世界已有的规则书；action=read_rulebook 读某套规则书；action=select_rulebook 切换本会话用哪套；' +
      'action=remove_rulebook 删一套。' +
      'Triggers: 载入世界书/导入设定/世界观资料, 查看世界书, 切换世界书, 世界书里关于X的内容, 生成规则书/写规则书/换一套规则.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: [
            'load', 'list', 'read', 'bind', 'find', 'remove',
            'write_rulebook', 'list_rules', 'read_rulebook', 'select_rulebook', 'remove_rulebook',
          ],
          description: '要执行的动作，默认 load。',
        },
        path: { type: 'string', description: 'action=load：工作区内的相对目录路径，如 corpus 或 worldbook/克苏鲁。' },
        name: { type: 'string', description: 'action=load：世界书展示名，缺省取目录名。' },
        worldId: { type: 'string', description: '目标世界书 id（缺省用当前会话绑定的那本）。' },
        listOnly: { type: 'boolean', description: 'action=load：只登记清单、不返回全文（大目录时用）。' },
        query: { type: 'string', description: 'action=find：关键词。' },
        maxChars: { type: 'number', description: 'action=read：返回全文的字符上限，默认 120000。' },
        style: {
          type: 'string',
          enum: RULE_STYLES.map((item) => item.id),
          description:
            'action=write_rulebook：规则风格。' +
            RULE_STYLES.map((item) => `${item.id}=${item.label}`).join('；'),
        },
        rulebookId: {
          type: 'string',
          description: 'action=write_rulebook 指定则覆盖同一套；action=read/select/remove_rulebook 指定目标。',
        },
        title: { type: 'string', description: 'action=write_rulebook：规则书标题。' },
        pitch: { type: 'string', description: 'action=write_rulebook：一句话说明这套规则的手感。' },
        markdown: { type: 'string', description: 'action=write_rulebook：规则书正文（完整 markdown）。' },
        schema: {
          type: 'object',
          description:
            'action=write_rulebook：机器可读定义 { system, summary, baseDice, direction: rollUnder|rollOver, ' +
            'difficultyLadder[{label,value}], defaultDifficulty, critSuccess?{min,max}, critFailure?{min,max}, ' +
            'attributes[{id,label,group?,kind?,min?,max?,base?,dice?,desc?}], skills[{id,label,attribute?,dice?,difficulty?,desc?}], ' +
            'statusSystem?, opposedTie?: defender|reroll|gm, adjudication?, poolTarget? }。' +
            '约定：rollUnder 下 difficultyLadder 的 value 是**修正值**（-50 近乎奇迹 … +40 显而易见，缺省 0），' +
            'defaultDifficulty 填 0；rollOver 下 value 是**绝对阈值**，defaultDifficulty 是缺省阈值；' +
            'd6 骰池用 poolTarget 指定「骰面 ≥ N 记一个成功」。',
        },
        select: { type: 'boolean', description: 'action=write_rulebook：写完后选为本会话规则（默认 true）。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          error: { type: 'string' },
          text: { type: 'string' },
          world: {},
          worlds: { type: 'array', items: {} },
          rules: { type: 'array', items: {} },
          matches: { type: 'array', items: {} },
        },
      },
      render: (_args, value) => {
        const v = value as {
          ok?: boolean
          error?: string
          action?: string
          text?: string
          world?: { id: string; name: string; path: string; fileCount: number; totalChars: number }
          worlds?: Array<{ id: string; name: string; path: string; fileCount: number; totalChars: number; ruleCount: number }>
          rules?: Array<{ id: string; title: string; style: string; system: string; baseDice: string; pitch?: string }>
          matches?: Array<{ rel: string; excerpt: string }>
        }
        if (v.ok === false) return text(`错误：${v.error ?? '未知错误'}`)
        if (v.action === 'find') {
          const hits = v.matches ?? []
          return text(hits.length === 0 ? '没有匹配内容。' : hits.map((hit) => `【${hit.rel}】\n${hit.excerpt}`).join('\n\n'))
        }
        if (v.worlds !== undefined) {
          return text(
            v.worlds.length === 0
              ? '当前工作区还没有载入任何世界书。'
              : v.worlds
                  .map(
                    (world) =>
                      `· ${world.name}（id=${world.id}）路径 ${world.path}｜${world.fileCount} 文件 / ${world.totalChars} 字符` +
                      `｜规则书 ${world.ruleCount} 套`,
                  )
                  .join('\n'),
          )
        }
        if (v.rules !== undefined && v.text === undefined && v.world !== undefined) {
          return text(
            `《${v.world.name}》的规则书（${v.rules.length} 套）：\n` +
              (v.rules.length === 0
                ? '（还没有：用 action=write_rulebook 写一套）'
                : v.rules
                    .map((rule) => `· ${rule.id}｜${rule.title}｜${rule.style}｜${rule.baseDice}｜${rule.system}${rule.pitch === undefined ? '' : `\n    ${rule.pitch}`}`)
                    .join('\n')),
          )
        }
        if (v.text !== undefined) return text(v.text)
        if (v.world !== undefined) {
          return text(
            `世界书《${v.world.name}》（id=${v.world.id}）：路径 ${v.world.path}，${v.world.fileCount} 个文本文件，` +
              `合计 ${v.world.totalChars} 字符。`,
          )
        }
        return text('完成。')
      },
    },
    async execute(args, exec) {
      try {
        const resolved = await resolveCaller(deps, exec)
        const action = String(args.action ?? 'load')
        const store = resolved.store

        if (action === 'list') {
          const worlds = await store.worlds()
          const binding = await store.binding(resolved.sessionId)
          return {
            ok: true,
            action,
            boundId: binding.worldId ?? null,
            worlds: await Promise.all(
              worlds.map(async (world) => ({
                ...world,
                files: [],
                ruleCount: (await store.rulesOf(world.id)).length,
              })),
            ),
          }
        }

        if (action === 'load') {
          const rel = String(args.path ?? '').trim()
          if (rel === '') throw new Error('action=load 需要 path（工作区内的相对目录）')
          const scanned = await scanWorldbook(resolved.cwd, rel, args.listOnly === true)
          const name = String(args.name ?? '').trim() || scanned.dirName
          const existing = await store.worlds()
          const world = await store.upsertWorld({
            id: store.suggestId(slugify(name), existing.map((item) => item.id)),
            name,
            path: scanned.rel,
            loadedAt: Date.now(),
            fileCount: scanned.files.length,
            totalChars: scanned.totalChars,
            files: scanned.files.map(({ rel: fileRel, chars, truncated, error }) => ({
              rel: fileRel,
              chars,
              truncated,
              ...(error === undefined ? {} : { error }),
            })),
          })
          await store.bindRun(resolved.sessionId, { worldId: world.id })
          const body = scanned.files
            .map((file) =>
              file.text === undefined
                ? `\n===== ${file.rel}（${file.chars} 字符${file.error === undefined ? '，仅清单' : `，${file.error}`}）=====`
                : `\n===== ${file.rel}（${file.chars} 字符${file.truncated ? '，已截断' : ''}）=====\n${file.text}`,
            )
            .join('\n')
          return {
            ok: true,
            action,
            world: { ...world, files: [] },
            text:
              `共 ${scanned.files.length} 个文本文件，合计 ${scanned.totalChars.toLocaleString('en-US')} 字符。\n${body}` +
              `\n\n下一步：调用 ${TOOL_WORLDBOOK} action=write_rulebook 为《${world.name}》写一套规则书（style 选 d100 / d20 / d6pool / custom）。`,
          }
        }

        const { worldId } = await requireWorld(resolved, String(args.worldId ?? ''))

        if (action === 'read') {
          const world = await store.world(worldId)
          if (world === undefined) throw new Error(`世界书不存在：${worldId}`)
          const scanned = await scanWorldbook(resolved.cwd, world.path)
          const limit = Number.isFinite(args.maxChars) ? Math.max(2000, Number(args.maxChars)) : 120_000
          const body = scanned.files
            .map((file) => (file.text === undefined ? `\n===== ${file.rel}（仅清单）=====` : `\n===== ${file.rel} =====\n${file.text}`))
            .join('\n')
          return {
            ok: true,
            action,
            world: { ...world, files: [] },
            text: body.length > limit ? `${body.slice(0, limit)}\n\n…（已按 maxChars 截断）` : body,
          }
        }

        if (action === 'bind') {
          const target = String(args.worldId ?? '').trim()
          const world = target === '' ? await store.world(worldId) : await store.world(target)
          if (world === undefined) throw new Error(`世界书不存在：${target || worldId}`)
          await store.bindRun(resolved.sessionId, { worldId: world.id })
          return { ok: true, action, world: { ...world, files: [] } }
        }

        if (action === 'remove') {
          const target = String(args.worldId ?? '').trim() || worldId
          const removed = await store.removeWorld(target)
          const binding = await store.binding(resolved.sessionId)
          if (binding.worldId === target) await store.bindRun(resolved.sessionId, { worldId: null })
          return { ok: true, action, removed }
        }

        if (action === 'find') {
          const needle = String(args.query ?? '').trim()
          if (needle === '') throw new Error('action=find 需要 query')
          const world = await store.world(worldId)
          if (world === undefined) throw new Error(`世界书不存在：${worldId}`)
          const scanned = await scanWorldbook(resolved.cwd, world.path)
          const lower = needle.toLowerCase()
          const matches: Array<{ rel: string; excerpt: string }> = []
          for (const file of scanned.files) {
            if (file.text === undefined) continue
            const haystack = file.text.toLowerCase()
            let index = haystack.indexOf(lower)
            let hits = 0
            while (index >= 0 && hits < 3 && matches.length < 40) {
              matches.push({
                rel: file.rel,
                excerpt: file.text.slice(Math.max(0, index - 160), Math.min(file.text.length, index + needle.length + 240)).replace(/\s+/g, ' ').trim(),
              })
              hits += 1
              index = haystack.indexOf(lower, index + needle.length)
            }
          }
          return { ok: true, action, matches, world: { ...world, files: [] } }
        }

        if (action === 'list_rules') {
          const world = await store.world(worldId)
          if (world === undefined) throw new Error(`世界书不存在：${worldId}`)
          const rules = await store.rulesOf(worldId)
          const binding = await store.binding(resolved.sessionId)
          return {
            ok: true,
            action,
            world: { ...world, files: [] },
            rules: rules.map((rule) => ({ ...rule, selected: rule.id === binding.rulebookId })),
          }
        }

        if (action === 'read_rulebook') {
          const rule = await requireRulebook(resolved, worldId)
          const target = String(args.rulebookId ?? '').trim()
          const pick =
            target === '' ? rule : ((await store.rulebook(worldId, target)) ?? rule)
          const read = await store.readRulebookMarkdown(pick)
          return {
            ok: true,
            action,
            world: { id: pick.worldId, name: '', path: '', fileCount: 0, totalChars: 0, files: [] },
            text:
              `规则书《${pick.title}》（id=${pick.id}｜${pick.style}｜${pick.schema.system}｜${pick.schema.baseDice}）` +
              `${pick.pitch === undefined ? '' : `\n手感：${pick.pitch}`}\n` +
              `属性：${pick.schema.attributes.map((a) => `${a.label}(${a.id})`).join('、') || '（无）'}\n` +
              `技能：${pick.schema.skills.map((s) => s.label).join('、') || '（无）'}\n` +
              `难度阶梯：${pick.schema.difficultyLadder.map((r) => `${r.label}=${r.value}`).join('、') || '（无）'}\n` +
              `${read.missing ? '⚠️ 工作区里的 md 已不在，以下是索引里的 schema\n' : ''}` +
              `—— 正文 ——\n${read.text}`,
            rules: [],
          }
        }

        if (action === 'select_rulebook') {
          const id = String(args.rulebookId ?? '').trim()
          if (id === '') throw new Error('action=select_rulebook 需要 rulebookId')
          const rule = await store.rulebook(worldId, id)
          if (rule === undefined) throw new Error(`规则书不存在：${id}`)
          await store.bindRun(resolved.sessionId, { rulebookId: rule.id })
          // 换规则书会改属性表：重建会话实例条目（保留已有取值）。
          const instance = await store.instance(resolved.sessionId, worldId, rule)
          await store.saveInstance(instance, 'agent')
          return {
            ok: true,
            action,
            world: { id: worldId, name: '', path: '', fileCount: 0, totalChars: 0, files: [] },
            rules: [{ id: rule.id, title: rule.title, style: rule.style, system: rule.schema.system, baseDice: rule.schema.baseDice }],
            text: `已切换到规则书《${rule.title}》（${rule.style}／${rule.schema.baseDice}）。角色卡的属性与技能表已按它重建。`,
          }
        }

        if (action === 'remove_rulebook') {
          const id = String(args.rulebookId ?? '').trim()
          if (id === '') throw new Error('action=remove_rulebook 需要 rulebookId')
          const removed = await store.removeRulebook(worldId, id)
          const binding = await store.binding(resolved.sessionId)
          if (binding.rulebookId === id) await store.bindRun(resolved.sessionId, { rulebookId: null })
          return { ok: true, action, removed }
        }

        if (action === 'write_rulebook') {
          const markdown = String(args.markdown ?? '')
          if (markdown.trim() === '') throw new Error('action=write_rulebook 需要 markdown')
          if (markdown.length > MAX_EDIT_CHARS) throw new Error('规则书过大（超过 600k 字符）')
          const world = await store.world(worldId)
          if (world === undefined) throw new Error(`世界书不存在：${worldId}`)
          const styleRaw = String(args.style ?? 'd100') as RuleStyle
          const info = ruleStyleInfo(styleRaw)
          const style: RuleStyle = RULE_STYLES.some((item) => item.id === styleRaw) ? styleRaw : 'custom'
          const title = String(args.title ?? '').trim() || `${world.rulesName ?? world.name}规则书（${style}）`
          const mdRel = await artifactRel(resolved, worldId, String(args.path ?? ''), `${title}.md`)
          const rule = await store.writeRulebook({
            worldId,
            ...(String(args.rulebookId ?? '').trim() === '' ? {} : { rulebookId: String(args.rulebookId).trim() }),
            title,
            style,
            ...(String(args.pitch ?? '').trim() === '' ? { pitch: info.flavour.slice(0, 120) } : { pitch: String(args.pitch) }),
            mdRel,
            markdown,
            schema: args.schema as RulesSchema,
            editedBy: 'agent',
          })
          const sheet = await store.instance(resolved.sessionId, worldId, rule)
          await store.saveInstance(sheet, 'agent')
          if (args.select !== false) await store.bindRun(resolved.sessionId, { rulebookId: rule.id })

          const missing: string[] = []
          if (rule.schema.skills.length === 0) missing.push('skills（没有技能表，判定只能用裸骰式）')
          if (rule.schema.attributes.length === 0) missing.push('attributes（角色卡将没有属性区）')
          if (rule.schema.difficultyLadder.length === 0) missing.push('difficultyLadder（难度只能用固定值）')
          if (rule.schema.statusSystem === undefined) missing.push('statusSystem（状态系统说明）')
          if (rule.schema.adjudication === undefined) missing.push('adjudication（判定原则）')
          const pending = sheet.attrs.filter((attr) => attr.pending === true)
          return {
            ok: true,
            action,
            world: { ...world, files: [] },
            rules: [{ id: rule.id, title: rule.title, style: rule.style, system: rule.schema.system, baseDice: rule.schema.baseDice }],
            text:
              `已写入规则书《${rule.title}》（id=${rule.id}｜风格 ${style}）→ ${rule.mdPath}\n` +
              `系统：${rule.schema.system}｜骰式 ${rule.schema.baseDice}｜方向 ${rule.schema.direction}｜属性 ${rule.schema.attributes.length} 项｜技能 ${rule.schema.skills.length} 项\n` +
              (missing.length === 0 ? '' : `⚠️ schema 缺项：${missing.join('、')}\n`) +
              `角色卡已按这套规则重建${pending.length === 0 ? '' : `，以下属性没有默认值、需要与玩家确认：${pending.map((attr) => attr.id).join('、')}`}\n` +
              `下一步：${TOOL_MODULE} action=generate 生成一个模组（开场引子），然后 ${TOOL_CHARACTER} 生成/挑选角色卡。`,
          }
        }

        throw new Error(`未知 action：${action}`)
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  })

  // ── 2. 模组集 ─────────────────────────────────────────────────────────────
  defs.push({
    name: TOOL_MODULE,
    description:
      '【模组集】一次冒险的开场引子：从哪一幕开始、初始局面、关键 NPC、悬念钩子与可能走向。' +
      'action=generate 依据世界书（建议先有规则书）写一个模组到工作区；action=list 看该世界的模组；' +
      'action=read 读某个模组正文；action=select 选定本会话要跑的模组；action=save 保存你手写的模组；action=remove 删除。' +
      '选定模组是开局的第三步（世界书 → 规则书 → 模组 → 角色卡）。' +
      'Triggers: 生成模组/开场引子, 模组集, 选哪个模组, 看模组, 我要跑哪个故事, 开场怎么开.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['generate', 'list', 'read', 'select', 'save', 'remove'],
          description: '要执行的动作。generate/save 需要 markdown。',
        },
        worldId: { type: 'string', description: '目标世界书 id（缺省用当前会话绑定的那本）。' },
        name: { type: 'string', description: 'generate/save：模组名。' },
        tagline: { type: 'string', description: 'generate/save：一句话钩子（列表里显示）。' },
        markdown: {
          type: 'string',
          description:
            'generate/save：开场引子正文（完整 markdown）。建议结构：一句话钩子 / 序幕与初始局面 / ' +
            '关键 NPC（各一句「想要什么、怕什么、瞒着什么」）/ 悬念与走向分支 / 首场判定提示。',
        },
        scale: { type: 'string', enum: ['one-shot', 'chapter', 'campaign'], description: '篇幅自评。' },
        players: { type: 'string', description: '建议人数 / 单人桌适配说明。' },
        tags: { type: 'array', items: { type: 'string' }, description: '标签，如「调查」「密闭空间」。' },
        rulebookId: { type: 'string', description: '建议搭配的规则书（可空）。' },
        moduleId: { type: 'string', description: 'read/select/remove/save：目标模组 id；给了就是覆盖那一份。' },
        select: { type: 'boolean', description: 'generate/save：写完选为本会话模组（默认 true）。' },
        maxChars: { type: 'number', description: 'read：正文返回上限，默认 40000。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          error: { type: 'string' },
          text: { type: 'string' },
          module: {},
          modules: { type: 'array', items: {} },
        },
      },
      render: (_args, value) => {
        const v = value as {
          ok?: boolean
          error?: string
          text?: string
          module?: { id: string; name: string; tagline: string; mdPath: string; scale?: string }
          modules?: Array<{ id: string; name: string; tagline: string; selected?: boolean; scale?: string }>
        }
        if (v.ok === false) return text(`错误：${v.error ?? '未知错误'}`)
        if (v.modules !== undefined && v.text === undefined) {
          return text(
            v.modules.length === 0
              ? '这个世界还没有模组：用 action=generate 生成一个开场引子。'
              : v.modules
                  .map(
                    (item) =>
                      `· ${item.id}｜${item.name}${item.scale === undefined ? '' : `（${item.scale}）`}${item.selected === true ? '｜★当前' : ''}\n    ${item.tagline}`,
                  )
                  .join('\n'),
          )
        }
        if (v.text !== undefined && v.text !== '') return text(v.text)
        if (v.module !== undefined) {
          return text(
            `已写入模组《${v.module.name}》（id=${v.module.id}）→ ${v.module.mdPath}\n钩子：${v.module.tagline}\n` +
              `下一步：${TOOL_CHARACTER} action=list 看角色池，或 action=generate 生成候选角色卡供玩家挑选。`,
          )
        }
        return text('完成。')
      },
    },
    async execute(args, exec) {
      try {
        const resolved = await resolveCaller(deps, exec)
        const store = resolved.store
        const action = String(args.action ?? 'list')
        const { worldId, world } = await requireWorld(resolved, String(args.worldId ?? ''))

        if (action === 'list') {
          const modules = await store.modulesOf(worldId)
          const binding = await store.binding(resolved.sessionId)
          return {
            ok: true,
            modules: modules.map((item) => ({
              id: item.id,
              name: item.name,
              tagline: item.tagline,
              ...(item.scale === undefined ? {} : { scale: item.scale }),
              selected: item.id === binding.moduleId,
            })),
          }
        }

        if (action === 'read') {
          const id = String(args.moduleId ?? '').trim() || (await store.binding(resolved.sessionId)).moduleId || ''
          if (id === '') throw new Error('action=read 需要 moduleId（或先 select 一个）')
          const module = await store.module(worldId, id)
          if (module === undefined) throw new Error(`模组不存在：${id}`)
          const read = await store.readModuleMarkdown(module)
          const limit = Number.isFinite(args.maxChars) ? Math.max(2000, Number(args.maxChars)) : 40_000
          const body = renderModuleBody(module, read.text)
          return { ok: true, text: body.length > limit ? `${body.slice(0, limit)}\n\n…（已截断）` : body }
        }

        if (action === 'select') {
          const id = String(args.moduleId ?? '').trim()
          if (id === '') throw new Error('action=select 需要 moduleId')
          const module = await store.module(worldId, id)
          if (module === undefined) throw new Error(`模组不存在：${id}`)
          await store.bindRun(resolved.sessionId, { moduleId: module.id })
          return {
            ok: true,
            module: { id: module.id, name: module.name, tagline: module.tagline, mdPath: module.mdPath },
            text:
              `已选定模组《${module.name}》。\n${module.tagline}\n` +
              `下一步：${TOOL_CHARACTER} action=list 挑选角色卡（或 action=generate 生成候选）。`,
          }
        }

        if (action === 'remove') {
          const id = String(args.moduleId ?? '').trim()
          if (id === '') throw new Error('action=remove 需要 moduleId')
          const removed = await store.removeModule(worldId, id)
          const binding = await store.binding(resolved.sessionId)
          if (binding.moduleId === id) await store.bindRun(resolved.sessionId, { moduleId: null })
          return { ok: true, modules: (await store.modulesOf(worldId)).map((item) => ({ id: item.id, name: item.name, tagline: item.tagline })), text: removed ? `已删除模组 ${id}。` : `模组 ${id} 不存在。` }
        }

        if (action === 'generate' || action === 'save') {
          const markdown = String(args.markdown ?? '')
          const name = String(args.name ?? '').trim()
          if (markdown.trim() === '') throw new Error(`${action} 需要 markdown（开场引子正文）`)
          if (name === '') throw new Error(`${action} 需要 name（模组名）`)
          if (markdown.length > MAX_EDIT_CHARS) throw new Error('模组过大（超过 600k 字符）')
          const module = await store.writeModule({
            worldId,
            ...(String(args.moduleId ?? '').trim() === '' ? {} : { moduleId: String(args.moduleId).trim() }),
            name,
            tagline: String(args.tagline ?? '').trim() || '（未写钩子）',
            mdRel: `modules/${name}.md`,
            markdown,
            ...(args.scale === undefined ? {} : { scale: args.scale as Module['scale'] }),
            ...(String(args.players ?? '').trim() === '' ? {} : { players: String(args.players) }),
            ...(Array.isArray(args.tags) ? { tags: args.tags.map((tag) => String(tag)) } : {}),
            ...(String(args.rulebookId ?? '').trim() === '' ? {} : { rulebookId: String(args.rulebookId).trim() }),
            source: 'agent',
          })
          if (args.select !== false) await store.bindRun(resolved.sessionId, { moduleId: module.id })
          return {
            ok: true,
            module: { id: module.id, name: module.name, tagline: module.tagline, mdPath: module.mdPath },
            text:
              `已写入模组《${module.name}》（世界《${world.name}》）→ ${module.mdPath}\n${module.tagline}\n` +
              `下一步：${TOOL_CHARACTER} action=list 看角色池，或 action=generate 依据「世界 + 规则 + 这个模组」生成候选角色卡。`,
          }
        }

        throw new Error(`未知 action：${action}`)
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  })

  // ── 3. 角色卡（角色池 + 会话实例） ─────────────────────────────────────────
  defs.push({
    name: TOOL_CHARACTER,
    description:
      '【角色卡】按世界组织的角色池与会话中正在扮演的那一张。' +
      'action=list 看当前世界的角色池（可挑选的模板）；action=generate 依据「世界书 + 规则书 + 模组」生成候选角色卡' +
      '（会连同创建时的问询结果一起写入池子）；action=select 把池里某一张导入本会话开始扮演；' +
      'action=get 读当前正在扮演的角色卡；action=update 增量修改（属性/技能按 id upsert，物品/队友/宠物/随从/状态/经历合并）；' +
      'action=save 把当前角色卡另存为池里的新模板（便于下次冒险复用）。' +
      'Triggers: 角色卡, 我的角色, 生成角色, 选择角色/换角色, 角色属性/技能/物品/队友/宠物/随从, 更新角色信息, 角色受伤/获得道具.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'generate', 'select', 'get', 'update', 'save'],
          description: '要执行的动作。',
        },
        worldId: { type: 'string', description: '目标世界书 id（缺省用当前会话绑定的那本）。' },
        templateId: { type: 'string', description: 'generate/save 时指定则覆盖同一张；select 时指定要导入的那张。' },
        name: { type: 'string', description: '角色名。' },
        concept: { type: 'string', description: '概念 / 职业 / 种族 / 出身。' },
        player: { type: 'string', description: '玩家名（可选）。' },
        attrs: {
          type: 'array',
          items: { type: 'object' },
          description: '属性：{ id, value, pending?, max?, note? }，id 必须来自规则 schema。',
        },
        skills: {
          type: 'array',
          items: { type: 'object' },
          description: '技能：{ id, value, pending?, note? }，id 必须来自规则 schema。',
        },
        slots: {
          type: 'array',
          items: { type: 'object' },
          description: '物品/队友/宠物/随从：{ id, name, kind: item|ally|pet|retainer, qty?, tag?, desc?, active? }。',
        },
        statuses: { type: 'array', items: { type: 'object' }, description: '状态：{ id, label, remaining?, kind?, desc? }。' },
        journal: { type: 'array', items: { type: 'object' }, description: '经历：{ id, title, text?, ts? }。' },
        notes: { type: 'string', description: '自由备注（对玩家可见，不要写需要保密的内容）。' },
        initialized: { type: 'boolean', description: '是否已与玩家确认完成。' },
        patch: { type: 'object', description: 'action=update 的增量补丁（与上面字段同构，另可带 removeAttrs/removeSkills/removeSlots/removeStatuses）。' },
        entry: {
          type: 'object',
          description: 'action=update 的便捷写法：一次加一条 { slot?: {...} | status?: {...} | journal?: {title,text?} }。',
        },
        moduleId: { type: 'string', description: '建议归属的模组（写入池子时记录）。' },
        select: { type: 'boolean', description: 'generate 后是否直接导入本会话开始扮演（默认 false，让玩家先挑）。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          error: { type: 'string' },
          text: { type: 'string' },
          character: {},
          templates: { type: 'array', items: {} },
          schemaAttrs: { type: 'array', items: {} },
          schemaSkills: { type: 'array', items: {} },
        },
      },
      render: (_args, value) => {
        const v = value as {
          ok?: boolean
          error?: string
          text?: string
          templates?: CharacterTemplate[]
          character?: CharacterBody & { templateId?: string }
          schemaAttrs?: Array<{ id: string; label: string }>
          schemaSkills?: Array<{ id: string; label: string }>
        }
        if (v.ok === false) return text(`错误：${v.error ?? '未知错误'}`)
        if (v.text !== undefined && v.text !== '') {
          // 写入/导入路径的说明（含「必须先用 ask_user_question 与玩家确认」）优先于池列表，
          // 池列表附在其后，避免关键流程提示被吞掉。
          const pool =
            v.templates === undefined || v.templates.length === 0
              ? ''
              : `\n\n角色池（${v.templates.length} 张）：\n` + v.templates.map((item) => templateLine(item)).join('\n')
          return text(v.text + pool)
        }
        if (v.templates !== undefined) {
          return text(
            v.templates.length === 0
              ? '角色池是空的：用 action=generate 生成候选角色卡（或 action=update 后 action=save）。'
              : `角色池（${v.templates.length} 张）：\n` + v.templates.map((item) => templateLine(item)).join('\n'),
          )
        }
        const sheet = v.character
        if (sheet !== undefined) {
          const labelOf = (id: string): string =>
            v.schemaAttrs?.find((item) => item.id === id)?.label ??
            v.schemaSkills?.find((item) => item.id === id)?.label ??
            id
          const attrs = sheet.attrs.map((attr) => `${labelOf(attr.id)}=${attr.value}${attr.pending === true ? '(待确认)' : ''}`)
          const skills = sheet.skills.filter((skill) => String(skill.value) !== '0' && String(skill.value) !== '').map((skill) => `${labelOf(skill.id)}=${skill.value}`)
          const group = (kind: SlotEntry['kind']): string =>
            sheet.slots
              .filter((slot) => slot.kind === kind && slot.name !== '')
              .map((slot) => `${slot.name}${slot.qty === undefined || slot.qty === 1 ? '' : `×${slot.qty}`}`)
              .join('、')
          return text(
            [
              `【${sheet.name || '（未命名）'}】${sheet.concept ?? ''}｜初始化 ${sheet.initialized ? '已完成' : '未完成'}${sheet.templateId === undefined ? '' : `｜来自角色池 ${sheet.templateId}`}`,
              `属性：${attrs.join('、') || '（空）'}`,
              ...(skills.length === 0 ? [] : [`技能：${skills.join('、')}`]),
              `物品：${group('item') || '（空）'}`,
              `队友：${group('ally') || '（空）'}｜随从：${group('retainer') || '（空）'}｜宠物：${group('pet') || '（空）'}`,
              ...(sheet.statuses.length === 0
                ? []
                : [`状态：${sheet.statuses.map((s) => `${s.label}${s.remaining === undefined ? '' : `(${s.remaining}回合)`}`).join('、')}`]),
              ...(sheet.journal.length === 0 ? [] : [`经历：${sheet.journal.slice(-8).map((j) => j.title).join(' / ')}`]),
              ...(sheet.notes === undefined || sheet.notes === '' ? [] : [`备注：${sheet.notes}`]),
            ].join('\n'),
          )
        }
        return text(v.text ?? '完成。')
      },
    },
    async execute(args, exec) {
      try {
        const resolved = await resolveCaller(deps, exec)
        const store = resolved.store
        const action = String(args.action ?? 'get')
        const { worldId } = await requireWorld(resolved, String(args.worldId ?? ''))
        const rulebook = (await store.rulesOf(worldId)).length === 0 ? undefined : await requireRulebook(resolved, worldId)

        if (action === 'list') {
          const templates = await store.pool(worldId)
          const instance = await store.instance(resolved.sessionId, worldId, rulebook)
          return {
            ok: true,
            templates,
            character: instance,
            text:
              `角色池共 ${templates.length} 张；本会话当前扮演：${instance.name || '（尚未导入角色卡）'}\n` +
              (templates.length === 0
                ? '池子是空的：用 action=generate 生成候选，或 action=update + action=save 手工建一张。'
                : `用 action=select templateId=<id> 导入其中一张开始扮演。`),
          }
        }

        /** 组装工具参数里的角色主体。 */
        const bodyFromArgs = (): CharacterBody => ({
          ...blankBody(),
          name: String(args.name ?? '').trim(),
          ...(String(args.concept ?? '').trim() === '' ? {} : { concept: String(args.concept) }),
          ...(String(args.player ?? '').trim() === '' ? {} : { player: String(args.player) }),
          attrs: Array.isArray(args.attrs) ? (args.attrs as CharacterBody['attrs']) : [],
          skills: Array.isArray(args.skills) ? (args.skills as CharacterBody['skills']) : [],
          slots: Array.isArray(args.slots) ? (args.slots as SlotEntry[]) : [],
          statuses: Array.isArray(args.statuses) ? (args.statuses as CharacterBody['statuses']) : [],
          journal: Array.isArray(args.journal) ? (args.journal as CharacterBody['journal']) : [],
          ...(String(args.notes ?? '') === '' ? {} : { notes: String(args.notes) }),
          initialized: args.initialized === true,
        })

        if (action === 'generate' || action === 'save') {
          if (rulebook === undefined) throw new Error('还没有规则书：先生成一套规则书（scorpio_worldbook action=write_rulebook），角色卡的属性表由它决定')
          const body = bodyFromArgs()
          if (body.name === '') throw new Error(`${action} 需要 name（角色名）`)
          const template = await store.saveTemplate(
            {
              worldId,
              ...(String(args.templateId ?? '').trim() === '' ? {} : { templateId: String(args.templateId).trim() }),
              body,
              rulebookId: rulebook.id,
              ...(String(args.moduleId ?? '').trim() === '' ? {} : { moduleId: String(args.moduleId).trim() }),
              generated: action === 'generate',
              source: 'agent',
            },
            rulebook,
          )
          if (args.select === true) {
            const binding = await store.binding(resolved.sessionId)
            await store.importTemplate(resolved.sessionId, template, {
              rulebookId: rulebook.id,
              ...(binding.moduleId === undefined ? {} : { moduleId: binding.moduleId }),
            })
            await store.bindRun(resolved.sessionId, { templateId: template.id })
          }
          const pending = template.attrs.filter((attr) => attr.pending === true)
          return {
            ok: true,
            templates: await store.pool(worldId),
            character: args.select === true ? await store.instance(resolved.sessionId, worldId, rulebook) : undefined,
            text:
              `已写入角色池：${template.id}｜${template.name}（${template.concept ?? '—'}）\n` +
              `属性：${template.attrs.map((attr) => `${attr.id}=${attr.value}${attr.pending === true ? '(待确认)' : ''}`).join('、') || '（空）'}\n` +
              (pending.length === 0
                ? ''
                : `⚠️ 这些属性没有默认值，必须先用 ask_user_question 与玩家确认：${pending.map((attr) => attr.id).join('、')}\n`) +
              (args.select === true
                ? '已导入本会话，开始扮演。'
                : `下一步：让玩家挑选（${TOOL_CHARACTER} action=list），再用 action=select templateId=${template.id} 导入本会话。`),
          }
        }

        if (action === 'select') {
          const id = String(args.templateId ?? '').trim()
          if (id === '') throw new Error('action=select 需要 templateId（可用 action=list 查看）')
          const template = await store.template(worldId, id)
          if (template === undefined) throw new Error(`角色卡不存在：${id}`)
          const binding = await store.binding(resolved.sessionId)
          const instance = await store.importTemplate(resolved.sessionId, template, {
            ...(rulebook === undefined ? {} : { rulebookId: rulebook.id }),
            ...(binding.moduleId === undefined ? {} : { moduleId: binding.moduleId }),
          })
          await store.bindRun(resolved.sessionId, { templateId: template.id })
          return {
            ok: true,
            character: instance,
            templates: await store.pool(worldId),
            text: `已导入角色卡《${instance.name}》开始扮演。四元组齐备后即可开演。`,
          }
        }

        if (action === 'get') {
          const instance = await store.instance(resolved.sessionId, worldId, rulebook)
          return {
            ok: true,
            character: instance,
            schemaAttrs: (rulebook?.schema.attributes ?? []).map((item) => ({ id: item.id, label: item.label })),
            schemaSkills: (rulebook?.schema.skills ?? []).map((item) => ({ id: item.id, label: item.label })),
          }
        }

        if (action === 'update') {
          if (rulebook === undefined) throw new Error('还没有规则书，属性无从对齐：先生成规则书')
          const patch = { ...((args.patch ?? {}) as CharacterPatch) }
          const entry = (args.entry ?? {}) as {
            slot?: SlotEntry
            status?: { id?: string; label: string; remaining?: number; kind?: 'buff' | 'debuff' | 'neutral'; desc?: string }
            journal?: { id?: string; title: string; text?: string }
          }
          if (entry.slot !== undefined) patch.slots = [...(patch.slots ?? []), entry.slot]
          if (entry.status !== undefined) {
            patch.statuses = [
              ...(patch.statuses ?? []),
              {
                id: entry.status.id ?? `status-${Date.now().toString(36)}`,
                label: entry.status.label,
                ...(entry.status.remaining === undefined ? {} : { remaining: entry.status.remaining }),
                ...(entry.status.kind === undefined ? {} : { kind: entry.status.kind }),
                ...(entry.status.desc === undefined ? {} : { desc: entry.status.desc }),
              },
            ]
          }
          if (entry.journal !== undefined) {
            patch.journal = [
              ...(patch.journal ?? []),
              {
                id: entry.journal.id ?? `j-${Date.now().toString(36)}`,
                ts: Date.now(),
                title: entry.journal.title,
                ...(entry.journal.text === undefined ? {} : { text: entry.journal.text }),
                by: 'agent',
              },
            ]
          }
          // 直接给出的顶层字段合并进补丁
          for (const key of ['name', 'concept', 'player', 'notes', 'initialized', 'attrs', 'skills', 'slots', 'statuses', 'journal'] as const) {
            const value = (args as Record<string, unknown>)[key]
            if (value === undefined) continue
            ;(patch as Record<string, unknown>)[key] = value
          }
          const attrIds = new Set(rulebook.schema.attributes.map((item) => item.id))
          const skillIds = new Set(rulebook.schema.skills.map((item) => item.id))
          const unknown = [
            ...(patch.attrs ?? []).filter((attr) => !attrIds.has(attr.id)).map((attr) => `属性 ${attr.id}`),
            ...(patch.skills ?? []).filter((skill) => !skillIds.has(skill.id)).map((skill) => `技能 ${skill.id}`),
          ]
          if (unknown.length > 0) {
            throw new Error(
              `规则书里没有这些条目：${unknown.join('、')}。可用属性：${[...attrIds].join('、')}；可用技能：${[...skillIds].join('、')}`,
            )
          }
          const instance = await store.patchInstance(resolved.sessionId, worldId, patch, 'agent', rulebook)
          return {
            ok: true,
            character: instance,
            schemaAttrs: rulebook.schema.attributes.map((item) => ({ id: item.id, label: item.label })),
            schemaSkills: rulebook.schema.skills.map((item) => ({ id: item.id, label: item.label })),
          }
        }

        throw new Error(`未知 action：${action}`)
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  })

  // ── 4. 判定 ───────────────────────────────────────────────────────────────
  defs.push({
    name: TOOL_ROLL,
    description:
      '骰子判定引擎：任何对剧情有影响的重要行动（玩家角色或 NPC）都必须先经过它再叙事。' +
      '支持通用骰 `NdM±K`、取高/取低 `4d6kh3`、命名检定 `check`（按规则书技能表取属性修正）、' +
      '难度 `difficulty`（rollUnder 取阶梯修正值，rollOver 取绝对阈值；d6 骰池则比较成功数）、' +
      '对抗判定 `opposed`、大成功/大失败。结果自动写入判定流水。' +
      '四元组（世界/规则/模组/角色卡）未齐备时会拒绝判定。' +
      'Triggers: 掷骰/骰子/判定/检定/roll/对抗, 我做X能不能成功, 攻击/闪避/说服/察觉/知识检定.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        check: { type: 'string', description: '命名检定（规则书里的技能 id 或名称）。' },
        expression: { type: 'string', description: '骰式；给了 check 时可省略。' },
        modifier: { type: 'number', description: '临时修正（务必在 reason 里写明来源）。' },
        reason: { type: 'string', description: '修正原因，如「手持手电 +10」。' },
        difficulty: {
          type: 'number',
          description:
            '难度：rollUnder 填阶梯里的**修正值**（-20 棘手、+40 显而易见，缺省 0）；' +
            'rollOver 填要够到的**绝对阈值**（缺省用规则书 defaultDifficulty）。',
        },
        opposed: {
          type: 'object',
          properties: { name: { type: 'string' }, expression: { type: 'string' }, value: { type: 'number' } },
          required: ['name'],
          description:
            '对抗判定：{ name: 对手名, expression?: 对手骰式, value?: 对手的目标值（技能值） }。' +
            '双方各掷一次，比较"相对各自目标值的余量"（rollUnder 余量 = 目标 − 骰值）；value 留空表示与玩家同目标，纯比骰运。',
        },
        action: { type: 'string', description: '这次判定的行动描述。' },
        actor: { type: 'string', description: '行动者：player（默认）或 npc:名字。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: { ok: { type: 'boolean' }, error: { type: 'string' }, result: {}, brief: { type: 'string' } },
      },
      render: (_args, value) => {
        const v = value as { ok?: boolean; error?: string; brief?: string }
        if (v.ok === false) return text(`判定失败：${v.error ?? '未知错误'}`)
        return text(v.brief ?? '判定完成。')
      },
    },
    async execute(args, exec) {
      try {
        const resolved = await resolveCaller(deps, exec)
        const { worldId } = await requireWorld(resolved)
        const rulebook = await requireRulebook(resolved, worldId)
        const instance = await resolved.store.instance(resolved.sessionId, worldId, rulebook)
        const binding = await resolved.store.binding(resolved.sessionId)
        if (instance.name === '' || instance.name === undefined) {
          throw new Error(
            `还没有导入角色卡：先用 ${TOOL_CHARACTER} action=list 挑选、action=select 导入，或用 action=generate 生成一张。`,
          )
        }
        const scene = binding.moduleId === undefined ? undefined : await resolved.store.module(worldId, binding.moduleId)
        if (scene === undefined) {
          throw new Error(
            binding.moduleId === undefined
              ? `还没有选定模组：先用 ${TOOL_MODULE} action=generate 生成一个开场引子，或 action=select 选一个。`
              : `绑定的模组「${binding.moduleId}」已不存在：请用 ${TOOL_MODULE} action=list 重新选一个（四元组未齐备前不判定）。`,
          )
        }
        const request = args as unknown as RollRequest
        if ((request.check === undefined || request.check === '') && (request.expression === undefined || request.expression === '')) {
          throw new Error('至少给出 check（命名检定）或 expression（骰式）之一')
        }
        const result = performRoll(request, { schema: rulebook.schema, sheet: instance })
        await resolved.store.appendRoll(result)
        const brief = [
          renderRoll(result),
          result.check !== undefined && result.check.attributeValue !== undefined
            ? `（属性 ${result.check.attribute} ${result.check.attributeValue}${result.check.skillValue === undefined ? '' : ` + 技能 ${result.check.skillValue}`}）`
            : '',
          '请依据该结论推进剧情：成功描述达成方式，失败描述代价与新的处境；大成功/大失败给出额外的收益或代价。',
        ]
          .filter((line) => line !== '')
          .join('\n')
        return { ok: true, result, brief }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  })

  // ── 5. 判定流水 ───────────────────────────────────────────────────────────
  defs.push({
    name: TOOL_LEDGER,
    description:
      '读取本工作区的判定流水（最近的掷骰记录：骰面、修正、难度、成败、结论），用于复盘与保持叙事前后一致。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'number', description: '返回条数，默认 20，最多 200。' },
        keyword: { type: 'string', description: '只看含该关键词的记录。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: { ok: { type: 'boolean' }, error: { type: 'string' }, text: { type: 'string' } },
      },
      render: (_args, value) => {
        const v = value as { ok?: boolean; error?: string; text?: string }
        if (v.ok === false) return text(`错误：${v.error ?? '未知错误'}`)
        return text(v.text ?? '')
      },
    },
    async execute(args, exec) {
      try {
        const resolved = await resolveCaller(deps, exec)
        const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(200, Number(args.limit))) : 20
        const view = await resolved.store.diceLedger(limit)
        const keyword = String(args.keyword ?? '').trim().toLowerCase()
        const entries =
          keyword === ''
            ? view.recent
            : view.recent.filter((entry) =>
                `${entry.action ?? ''} ${entry.reason ?? ''} ${entry.check?.label ?? ''} ${entry.verdict}`
                  .toLowerCase()
                  .includes(keyword),
              )
        if (entries.length === 0) return { ok: true, text: '没有匹配的判定流水。' }
        return {
          ok: true,
          text:
            `判定流水共 ${view.total} 条，展示 ${entries.length} 条：\n` +
            entries
              .map((entry) => {
                const when = new Date(entry.ts).toLocaleString('zh-CN', { hour12: false })
                const what = entry.check?.label ?? entry.action ?? '通用判定'
                const pool = entry.roll.successes === undefined ? '' : `（成功数 ${entry.roll.successes}）`
                return `${when}｜${what}｜${entry.roll.total}${pool}${entry.roll.target === undefined ? '' : `/${entry.roll.target}`}｜${entry.verdict}`
              })
              .join('\n'),
        }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  })

  // ── 6. 开局四元组 ─────────────────────────────────────────────────────────
  defs.push({
    name: TOOL_RUN,
    description:
      '一次冒险的四元组总控：查看或设置「世界书 + 规则书 + 模组 + 角色卡」。' +
      'action=get 看当前进度与还缺哪一环；action=set 直接设置其中若干项（worldId/rulebookId/moduleId/templateId）；' +
      'action=start 在四元组齐备时标记开演。四元组齐备之前不要开始叙事。' +
      'Triggers: 开局, 现在到哪一步了, 还差什么, 开始冒险, 这次跑哪个世界哪个模组.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['get', 'set', 'start'], description: '默认 get。' },
        worldId: { type: 'string', description: 'action=set：世界书 id（空字符串＝清空）。' },
        rulebookId: { type: 'string', description: 'action=set：规则书 id。' },
        moduleId: { type: 'string', description: 'action=set：模组 id。' },
        templateId: { type: 'string', description: 'action=set：从角色池导入哪一张角色卡。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: { ok: { type: 'boolean' }, error: { type: 'string' }, text: { type: 'string' }, run: {} },
      },
      render: (_args, value) => {
        const v = value as { ok?: boolean; error?: string; text?: string }
        if (v.ok === false) return text(`错误：${v.error ?? '未知错误'}`)
        return text(v.text ?? '')
      },
    },
    async execute(args, exec) {
      try {
        const resolved = await resolveCaller(deps, exec)
        const store = resolved.store
        const action = String(args.action ?? 'get')
        const report = async (lead: string): Promise<{ run: RunReport; text: string }> => {
          const { run } = await buildRunReport(store, resolved.sessionId)
          return {
            run,
            text:
              `${lead}\n${runLine(run)}\n` +
              (run.ready ? '四元组齐备，可以开演。' : `还缺：${run.missing.join('、')}`) +
              `\n下一步：${run.next}`,
          }
        }
        if (action === 'get') {
          const { run, text: body } = await report('本次冒险的四元组：')
          return { ok: true, run, text: body }
        }
        if (action === 'set') {
          const patch: Parameters<ScorpioStore['bindRun']>[1] = {}
          if (args.worldId !== undefined) patch.worldId = String(args.worldId) || null
          if (args.rulebookId !== undefined) patch.rulebookId = String(args.rulebookId) || null
          if (args.moduleId !== undefined) patch.moduleId = String(args.moduleId) || null
          if (args.templateId !== undefined) patch.templateId = String(args.templateId) || null
          await store.bindRun(resolved.sessionId, patch)
          const binding = await store.binding(resolved.sessionId)
          if (args.templateId !== undefined && String(args.templateId) !== '' && binding.worldId !== undefined) {
            const template = await store.template(binding.worldId, String(args.templateId))
            if (template === undefined) throw new Error(`角色卡不存在：${String(args.templateId)}`)
            await store.importTemplate(resolved.sessionId, template, {
              ...(binding.rulebookId === undefined ? {} : { rulebookId: binding.rulebookId }),
              ...(binding.moduleId === undefined ? {} : { moduleId: binding.moduleId }),
            })
          }
          const { run, text: body } = await report('已更新四元组：')
          return { ok: true, run, text: body }
        }
        if (action === 'start') {
          const { run } = await buildRunReport(store, resolved.sessionId)
          if (!run.ready) {
            return { ok: false, text: `还不能开演，缺少：${run.missing.join('、')}\n下一步：${run.next}`, run }
          }
          await store.bindRun(resolved.sessionId, { startedAt: Date.now() })
          return {
            ok: true,
            run,
            text: `开演。\n${runLine(run)}\n先读模组开场，然后用第二人称、现在时把玩家放进第一幕；每次重要行动先 ${TOOL_ROLL}。`,
          }
        }
        throw new Error(`未知 action：${action}`)
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  })

  // ── 7. 状态自检 ───────────────────────────────────────────────────────────
  defs.push({
    name: TOOL_STATUS,
    description:
      '天蝎座模式自检：当前会话、预设、工作区、世界书、该世界的规则书、模组、角色卡与判定流水一次看全，' +
      '并给出下一步。开始推演前、或不确定下一步该做什么时应先调用它。' +
      'Triggers: 天蝎座状态, 现在到哪一步了, 自检, 准备好开始了吗.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: { ok: { type: 'boolean' }, error: { type: 'string' }, text: { type: 'string' }, run: {} },
      },
      render: (_args, value) => {
        const v = value as { ok?: boolean; error?: string; text?: string }
        if (v.ok === false) return text(`错误：${v.error ?? '未知错误'}`)
        return text(v.text ?? '')
      },
    },
    async execute(_args, exec) {
      try {
        const resolved = await resolveCaller(deps, exec)
        const store = resolved.store
        const worlds = await store.worlds()
        const { run } = await buildRunReport(store, resolved.sessionId)
        const binding = await store.binding(resolved.sessionId)
        const rules = binding.worldId === undefined ? [] : await store.rulesOf(binding.worldId)
        const modules = binding.worldId === undefined ? [] : await store.modulesOf(binding.worldId)
        const pool = binding.worldId === undefined ? [] : await store.pool(binding.worldId)
        const dice = await store.diceLedger(1)
        const instance =
          binding.worldId === undefined
            ? undefined
            : await store.instance(
                resolved.sessionId,
                binding.worldId,
                binding.rulebookId === undefined ? undefined : await store.rulebook(binding.worldId, binding.rulebookId),
              )
        const pending = instance?.attrs.filter((attr) => attr.pending === true) ?? []
        return {
          ok: true,
          run,
          text: [
            `会话 ${resolved.sessionId}｜预设 scorpio ✓｜工作区 ${resolved.cwd}`,
            `世界书：${worlds.length} 本${binding.worldId === undefined ? '' : `（当前《${binding.worldId}》）`}`,
            `规则书：${rules.length} 套${binding.rulebookId === undefined ? '' : `（当前 ${binding.rulebookId}）`}`,
            `模组集：${modules.length} 个${binding.moduleId === undefined ? '' : `（当前 ${binding.moduleId}）`}`,
            `角色池：${pool.length} 张｜本会话扮演：${instance?.name === undefined || instance.name === '' ? '（尚未导入）' : instance.name}` +
              `${pending.length === 0 ? '' : `｜待确认 ${pending.length} 项`}`,
            `判定流水：${dice.total} 条`,
            `开局进度：${runLine(run)}`,
            `下一步：${run.next}`,
          ].join('\n'),
        }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  })

  return {
    registerTools(tools, prompt) {
      const disposers: Array<() => void> = []
      for (const def of defs) {
        try {
          disposers.push(tools.register(def))
        } catch (error) {
          log('tool register failed:', def.name, String(error))
        }
      }
      if (prompt !== undefined) {
        disposers.push(
          prompt.section({ name: `${DICE_PREFIX}trpg-core`, order: 44, text: () => TRPG_CORE_PROMPT }),
        )
      }
      log(`registered ${disposers.length} scorpio tool/prompt contribution(s)`)
      return () => {
        for (const dispose of disposers) {
          try {
            dispose()
          } catch {
            /* 已释放 */
          }
        }
      }
    },
  }
}

/** 与 routes.ts 同构的四元组解析（工具层不经过 HTTP，故本地实现一次）。 */
async function buildRunReport(store: ScorpioStore, sessionId: string): Promise<{ run: RunReport }> {
  const binding = await store.binding(sessionId)
  const world = binding.worldId === undefined ? undefined : await store.world(binding.worldId)
  const rulebook =
    world === undefined || binding.rulebookId === undefined
      ? undefined
      : await store.rulebook(world.id, binding.rulebookId)
  const module =
    world === undefined || binding.moduleId === undefined
      ? undefined
      : await store.module(world.id, binding.moduleId)
  const instance = world === undefined ? undefined : await store.instance(sessionId, world.id, rulebook)
  const missing: RunReport['missing'] = []
  if (world === undefined) missing.push('world')
  if (rulebook === undefined) missing.push('rulebook')
  if (module === undefined) missing.push('module')
  if (instance === undefined || instance.name === '') missing.push('character')
  const next =
    world === undefined
      ? `① 载入世界书：${TOOL_WORLDBOOK} action=load path=<工作区内的目录>`
      : rulebook === undefined
        ? `② 生成规则书：${TOOL_WORLDBOOK} action=write_rulebook style=d100|d20|d6pool（可多套，玩家可挑）`
        : module === undefined
          ? `③ 生成或挑选模组：${TOOL_MODULE} action=generate / list / select`
          : instance === undefined || instance.name === ''
            ? `④ 生成或挑选角色卡：${TOOL_CHARACTER} action=generate / list / select`
            : '⑤ 四元组齐备：用 scorpio_run action=start 开演，之后每次重要行动先 scorpio_roll'
  return {
    run: {
      ...(world === undefined
        ? {}
        : { world: { id: world.id, name: world.name, fileCount: world.fileCount, totalChars: world.totalChars } }),
      ...(rulebook === undefined
        ? {}
        : {
            rulebook: {
              id: rulebook.id,
              title: rulebook.title,
              style: rulebook.style,
              system: rulebook.schema.system,
              baseDice: rulebook.schema.baseDice,
              ...(rulebook.pitch === undefined ? {} : { pitch: rulebook.pitch }),
            },
          }),
      ...(module === undefined
        ? {}
        : {
            module: {
              id: module.id,
              name: module.name,
              tagline: module.tagline,
              ...(module.scale === undefined ? {} : { scale: module.scale }),
            },
          }),
      ...(instance === undefined
        ? {}
        : {
            character: {
              name: instance.name,
              ...(instance.concept === undefined ? {} : { concept: instance.concept }),
              initialized: instance.initialized,
              ...(instance.templateId === undefined ? {} : { templateId: instance.templateId }),
            },
          }),
      missing,
      ready: missing.length === 0,
      next,
    },
  }
}

/** 主线提示词：只在 Scorpio 预设里注册，因此不会污染其他预设。 */
export const TRPG_CORE_PROMPT = `# 天蝎座（Scorpio）实时推演模式

你是一场实时线上 TRPG（桌面角色扮演）的主持人（GM/守秘人）。玩家扮演**一名**角色，你负责世界、NPC、规则裁定与叙事。

天蝎座的能力分成三条主线 + 一套判定：
- **【世界书】** 工作区里的世界观资料；同一本世界书下可以有**多套不同风格的规则书**（d100 / d20 / d6 骰池 / 自定义）。
- **【模组集】** 一本世界书下可以有许多**模组**——每个模组就是一次冒险的**开场引子**。
- **【角色卡】** 按世界组织、可复用的**角色池**；一次冒险把其中一张**导入**成正在扮演的角色。
- **【判定】** 任何影响剧情的行动都先掷骰再叙事。

侧边栏「天蝎座」页签有三个子页（世界书 / 模组集 / 角色卡），规则书收在世界书之下；判定用一个可拖拽的悬浮卡随时可用。你写进状态文件的一切都会立刻显示在那里。

## 开局四元组（硬性顺序，不可跳步）

每次冒险（会话）是一个四元组：**世界书 + 规则书 + 模组 + 角色卡**。四者齐备前**不要开始叙事**，用 \`scorpio_run\` 随时核对进度。

1. **世界书**：\`scorpio_worldbook\` \`action=load\` \`path=<工作区内的目录>\`，然后通读。
2. **规则书**：\`scorpio_worldbook\` \`action=write_rulebook\`，**必须同时给出 schema**（属性表、技能表、判定公式、难度阶梯、大成功/大失败、状态系统）。
   - 同一世界可以写**多套**：先与玩家确认风格，或直接按世界书气质推荐 1–2 套。
   - 三种常用风格（\`style\`）：\`d100\` 细颗粒度、线性均匀、偏扮演；\`d20\` 颗粒度粗、等级膨胀、戏剧性战斗；\`d6pool\` 钟形分布、结果可预期、能力越强越稳定（用 \`poolTarget\` 指定「骰面 ≥ N 记一个成功」，结算比成功数）。
   - 写完后用 \`action=list_rules\` 让玩家挑，\`action=select_rulebook\` 切换。
3. **模组**：\`scorpio_module\` \`action=generate\`——依据世界书（与已定规则）写一个**开场引子**：一句话钩子、序幕与初始局面、关键 NPC（各一句「想要什么、怕什么、瞒着什么」）、悬念与走向分支、首场判定提示。也可以用 \`action=list\` 让玩家从已有模组里挑。
4. **角色卡**：\`scorpio_character\`——把「生成候选」与「挑选」当成两件事：
   - \`action=generate\` 依「世界 + 规则 + 这个模组」生成候选角色卡（写进角色池，不直接开演）；
   - 用 \`ask_user_question\` 让玩家在候选之间挑选、并逐项确认（姓名/概念、属性分配、技能取向、初始物品、队友/宠物/随从、开场处境）；
   - \`action=select\` 把玩家选中的那张导入会话；属性/技能 id 必须来自规则书 schema，未确认的项保留 \`pending\`。
5. **开演**：\`scorpio_run\` \`action=start\`，然后从模组的开场第一幕开始。

## 判定先行（本模式的核心规则）

- **任何对剧情有影响的重要行动，玩家角色与 NPC 都要先判定**：攻击、闪避、说服、潜行、侦查、知识、驾驶、抵抗恐惧、攀爬、开锁、谈判……凡有失败可能且失败有意义的，一律先掷骰。
- 顺序永远是：**声明行动 → \`scorpio_roll\` → 依据结论叙事**。禁止先写结果再补骰，禁止"为叙事方便"跳过判定或事后修改骰值。
- 优先**命名检定**（\`check\` 传规则书技能名），让属性与技能修正自动生效；规则书没有对应技能时才用裸骰式。
- 难度：\`rollUnder\` 系统填阶梯修正值（-20 棘手 / +40 显而易见）；\`rollOver\` 系统填要够到的绝对阈值。修正要克制并写明来源（\`modifier\` + \`reason\`）。
- 对抗（潜行 vs 侦查、擒抱 vs 挣脱、谎言 vs 洞察）用 \`opposed\`，双方各掷一次。
- 结果用法：成功描述**如何**达成；失败描述代价、延误与新处境（不要用"什么都没发生"打发）；大成功给额外收益，大失败引入额外代价。
- 只有纯粹无风险的日常动作才不判定；玩家说"我要过个判定"时立刻掷骰。

## 叙事风格

- 第二人称、现在时、感官细节优先；每次推进给玩家留出可操作的具体选项，但不要替玩家做决定。
- NPC 有自己的目的与信息差；玩家看不到的东西不要写进玩家视角，需要保密的内容不要写进角色卡备注（角色卡对玩家可见）。
- 一处场景结束时把关键后果落进状态：\`scorpio_character\` \`action=update\`（\`entry\` 便捷写法一次加一条物品/状态/经历）。
- 每次判定或场景切换后，简要提醒玩家可以在侧边栏查看/修改世界书、模组、角色卡，并用悬浮判定卡自己掷一次。

## 边界

- 工具只在 Scorpio 预设下可用；调用失败时先 \`scorpio_status\` 自检看卡在哪一步。
- 世界书、规则书、模组、角色卡都是工作区里的明文文件，玩家可以手改。以文件为准，必要时同步 schema。
- 不虚构工具返回：骰值、难度、流水号一律来自 \`scorpio_roll\` 的真实返回。`
