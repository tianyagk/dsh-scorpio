/**
 * dsh-scorpio — 两端共享契约。
 *
 * 天蝎座的核心能力被拆成三条主线，规则书降级为世界书的派生产物：
 *
 *   【世界书】 世界观资料（工作区内的文本目录）
 *      └─ 规则书 ×N   同一个世界可以有多套不同风格的规则（d100 / d20 / d6 骰池 / 自定义）
 *   【模组集】 某个世界下的一个个「开场引子」：从哪一幕开始、关键 NPC、悬念与走向
 *   【角色卡】 按世界组织、可复用的角色池；一次会话导入其中一张作为本次扮演
 *
 * 每次冒险（会话）是一个四元组：world + rulebook + module + character。
 * 四者齐备之前不进入推演。
 *
 * 这里的每个类型都必须是**无损 JSON**：要么写进工作区明文文件，要么跨
 * `/scorpio/*` 路由传给浏览器。绝不引入 Node 或 DSH 运行时对象。
 */

/** 每个工作区内的状态目录（相对 session 的 cwd）。 */
export const STATE_DIR = '.scorpio'

export const FILE_BINDING = 'session.json'
export const FILE_DICE = 'dice.jsonl'
export const WORLDS_DIR = 'worlds'
export const RULES_DIR = 'rules'
export const MODULES_DIR = 'modules'
export const CHARS_DIR = 'characters'

/** 世界书扫描：可读文本扩展名（小写，含点）。 */
export const TEXT_EXTS: readonly string[] = [
  '.md', '.markdown', '.mdx', '.txt', '.text', '.log',
  '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.csv', '.tsv',
  '.html', '.htm', '.xml', '.tex',
]

export const MAX_FILE_CHARS = 240_000
export const MAX_BOOK_CHARS = 1_200_000
export const MAX_FILES = 600
export const MAX_DEPTH = 6
export const SKIP_DIRS: readonly string[] = [
  '.git', '.hg', '.svn', 'node_modules', '.scorpio', '.venv', 'venv',
  '__pycache__', 'dist', 'build', 'out', 'target', '.cache', '.idea', '.vscode',
  '.next', '.nuxt', 'coverage', '.pnpm-store',
]

export const NOTE_MAX = 400
export const MAX_BODY = 4 * 1024 * 1024
export const MAX_EDIT_CHARS = 600_000

export const PRESET_ID = 'scorpio'
export const PLUGIN_ID = 'dsh-scorpio'
/** 插件版本：宿主与客户端只读这一份，避免两处常量漂移。 */
export const VERSION = '0.2.0'
export const TAB_ID = 'dsh-scorpio'
export const OVERLAY_ID = 'dsh-scorpio-dice'
export const DICE_PREFIX = 'scorpio_'

export const TOOL_WORLDBOOK = 'scorpio_worldbook'
export const TOOL_MODULE = 'scorpio_module'
export const TOOL_CHARACTER = 'scorpio_character'
export const TOOL_ROLL = 'scorpio_roll'
export const TOOL_LEDGER = 'scorpio_ledger'
export const TOOL_RUN = 'scorpio_run'
export const TOOL_STATUS = 'scorpio_status'

/** 规则书的「风格」——决定判定手感，也是给模型写规则书时的明确档位。 */
export type RuleStyle = 'd100' | 'd20' | 'd6pool' | 'custom'

export interface RuleStyleInfo {
  id: RuleStyle
  label: string
  /** 手感描述：模型据此撰写规则书正文，玩家据此挑选。 */
  flavour: string
  /** 该风格的默认骨架（模型可在此基础上改写）。 */
  skeleton: {
    baseDice: string
    direction: 'rollUnder' | 'rollOver'
    defaultDifficulty: number
    defaultLadder: Array<{ label: string; value: number }>
    poolTarget?: number
  }
}

export const RULE_STYLES: readonly RuleStyleInfo[] = [
  {
    id: 'd100',
    label: 'D100 低位（细颗粒度 · 线性均匀 · 侧重扮演）',
    flavour:
      '骰值 1–100 线性均匀分布，每一档修正都有可见影响。判定颗粒度细、需要核对属性与技能加成，' +
      '节奏偏慢但过程透明；适合调查、扮演、恐惧与代价主题。',
    skeleton: {
      baseDice: '1d100',
      direction: 'rollUnder',
      defaultDifficulty: 0,
      defaultLadder: [
        { label: '近乎奇迹', value: -50 },
        { label: '残酷', value: -40 },
        { label: '严苛', value: -30 },
        { label: '棘手', value: -20 },
        { label: '普通', value: 0 },
        { label: '轻松', value: 20 },
        { label: '显而易见', value: 40 },
      ],
    },
  },
  {
    id: 'd20',
    label: 'D20 高骰（等级膨胀 · 戏剧性战斗 · 英雄奇幻）',
    flavour:
      '骰值 1–20 颗粒度粗，细微差异容易被淹没；加值随等级线性增长、DC 随等级同步抬升，形成等级膨胀。' +
      '适合英雄奇幻、战术战斗与升级成长，胜负更戏剧化。',
    skeleton: {
      baseDice: '1d20',
      direction: 'rollOver',
      defaultDifficulty: 12,
      defaultLadder: [
        { label: '轻松', value: 8 },
        { label: '普通', value: 12 },
        { label: '困难', value: 16 },
        { label: '极难', value: 20 },
        { label: '近乎不可能', value: 25 },
      ],
    },
  },
  {
    id: 'd6pool',
    label: 'D6 骰池（钟形曲线 · 结果可预期 · 能力越强越稳定）',
    flavour:
      '多枚 d6 组成骰池，成功数呈钟形分布：加值/减值在中间区间影响最大、极端区间影响小，' +
      '结果更可预期、减少极端翻车，能表现「能力越强越稳定」，代价是投掷与统计稍繁琐。' +
      '结算用「成功数 ≥ 难度」。',
    skeleton: {
      baseDice: '4d6',
      direction: 'rollOver',
      defaultDifficulty: 2,
      defaultLadder: [
        { label: '顺手', value: 1 },
        { label: '普通', value: 2 },
        { label: '吃力', value: 3 },
        { label: '险境', value: 4 },
        { label: '绝境', value: 5 },
      ],
      poolTarget: 5,
    },
  },
  {
    id: 'custom',
    label: '自定义（按世界观现场裁量）',
    flavour: '不拘一格：按世界书的气质自定骰式、难度与结算方式，但必须在 schema 与正文里写清楚。',
    skeleton: {
      baseDice: '2d6',
      direction: 'rollOver',
      defaultDifficulty: 8,
      defaultLadder: [
        { label: '容易', value: 6 },
        { label: '普通', value: 8 },
        { label: '困难', value: 10 },
      ],
    },
  },
]

export function ruleStyleInfo(id: RuleStyle | undefined): RuleStyleInfo {
  return RULE_STYLES.find((item) => item.id === id) ?? (RULE_STYLES[0] as RuleStyleInfo)
}

/** 把一个名字变成可做文件名/目录名的 id。 */
export function slugify(input: string, fallback = 'world'): string {
  const base = String(input ?? '')
    .trim()
    .replace(/\.[A-Za-z0-9]+$/, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return base === '' ? fallback : base
}

/** 路径是否是一个「文本类」文件（按扩展名判断）。 */
export function isTextFile(name: string): boolean {
  const lower = name.toLowerCase()
  const dot = lower.lastIndexOf('.')
  if (dot < 0) return false
  return TEXT_EXTS.includes(lower.slice(dot))
}

/** 是否应跳过该目录（隐藏目录与常见产物目录）。 */
export function isSkippedDir(name: string): boolean {
  const lower = name.toLowerCase()
  return SKIP_DIRS.includes(lower) || (lower.startsWith('.') && lower !== '.')
}

// ── 世界书 ─────────────────────────────────────────────────────────────────

export interface WorldbookFile {
  rel: string
  chars: number
  truncated: boolean
  text?: string
  error?: string
}

/** 世界观本体（`.scorpio/worlds/index.json` 的一行）。 */
export interface World {
  id: string
  name: string
  /** 相对工作区根的资料目录（POSIX）。 */
  path: string
  loadedAt: number
  fileCount: number
  totalChars: number
  files: Array<Pick<WorldbookFile, 'rel' | 'chars' | 'truncated' | 'error'>>
  note?: string
  /** 给规则书用的书名（默认取 name）。 */
  rulesName?: string
}

export interface WorldIndex {
  v: 2
  worlds: World[]
  activeId?: string
}

// ── 规则书（世界书下的子项，可多套） ────────────────────────────────────────

export interface Rulebook {
  id: string
  worldId: string
  title: string
  style: RuleStyle
  /** 一句话说明这套规则的手感（侧边栏与模型都读它）。 */
  pitch?: string
  /** 相对工作区根的 markdown 路径。 */
  mdPath: string
  schema: RulesSchema
  writtenAt: number
  editedBy?: 'agent' | 'user'
}

export interface RulesIndex {
  v: 2
  byWorld: Record<string, Rulebook[]>
}

// ── 规则 schema（角色卡按它渲染，判定按它取数） ──────────────────────────────

export type AttributeKind = 'number' | 'modifier' | 'pool' | 'rating' | 'tag' | 'dice'

export interface AttributeDef {
  id: string
  label: string
  group?: string
  kind?: AttributeKind
  min?: number
  max?: number
  base?: number
  dice?: string
  desc?: string
  collapsed?: boolean
}

export interface SkillDef {
  id: string
  label: string
  attribute?: string
  dice?: string
  difficulty?: number
  orAttributes?: string[]
  desc?: string
}

export interface DifficultyRung {
  label: string
  value: number
  desc?: string
}

export interface RulesSchema {
  version: 1
  system: string
  summary?: string
  /** 判定骰式骨架：`1d100` / `1d20` / `6d6` … */
  baseDice: string
  direction: 'rollUnder' | 'rollOver'
  difficultyLadder: DifficultyRung[]
  defaultDifficulty: number
  critSuccess?: { min?: number; max?: number }
  critFailure?: { min?: number; max?: number }
  attributes: AttributeDef[]
  skills: SkillDef[]
  statusSystem?: string
  opposedTie?: 'defender' | 'reroll' | 'gm'
  adjudication?: string
  /** 骰池风格：单个骰面 ≥ 该值算一个成功（如 5）。 */
  poolTarget?: number
}

// ── 模组集 ─────────────────────────────────────────────────────────────────

/** 一个模组 = 一次冒险的开场引子。 */
export interface Module {
  id: string
  worldId: string
  /** 建议搭配的规则书（可空，空则用会话选定的那一套）。 */
  rulebookId?: string
  name: string
  /** 一句话钩子（列表里显示）。 */
  tagline: string
  /** 开场引子正文（markdown）：背景提要、初始局面、关键 NPC、悬念与走向。 */
  mdPath: string
  /** 篇幅自评。 */
  scale?: 'one-shot' | 'chapter' | 'campaign'
  players?: string
  tags?: string[]
  createdAt: number
  updatedAt: number
  source: 'agent' | 'user'
}

export interface ModuleIndex {
  v: 2
  byWorld: Record<string, Module[]>
}

// ── 角色卡（按世界组织：角色池 + 会话中的实例） ──────────────────────────────

export type SlotKind = 'item' | 'ally' | 'pet' | 'retainer'

export interface SlotEntry {
  id: string
  name: string
  kind: SlotKind
  qty?: number
  tag?: string
  desc?: string
  active?: boolean
  owner?: 'user' | 'gm'
  meta?: Record<string, string | number | boolean>
}

export interface AttrValue {
  id: string
  value: number | string
  pending?: boolean
  note?: string
  max?: number
}

export interface StatusEffect {
  id: string
  label: string
  remaining?: number
  desc?: string
  kind?: 'buff' | 'debuff' | 'neutral'
}

export interface JournalEntry {
  id: string
  ts: number
  title: string
  text?: string
  by?: 'agent' | 'user'
}

/** 角色卡主体：角色池模板与会话实例同构。 */
export interface CharacterBody {
  name: string
  concept?: string
  player?: string
  attrs: AttrValue[]
  skills: Array<{ id: string; value: number | string; pending?: boolean; note?: string }>
  slots: SlotEntry[]
  statuses: StatusEffect[]
  journal: JournalEntry[]
  notes?: string
  initialized: boolean
}

/** 角色池里的一张可复用角色卡。 */
export interface CharacterTemplate extends CharacterBody {
  id: string
  worldId: string
  /** 推荐搭配的规则书（属性表来自它）。 */
  rulebookId?: string
  /** 建议搭配的模组（可为空＝通用）。 */
  moduleId?: string
  createdAt: number
  updatedAt: number
  source: 'agent' | 'user'
  /** 由模型生成（区别于用户手写）。 */
  generated?: boolean
}

export interface CharacterIndex {
  v: 2
  byWorld: Record<string, CharacterTemplate[]>
}

/** 会话中正在扮演的角色卡（角色池某一张的实例副本）。 */
export interface CharacterInstance extends CharacterBody {
  v: 2
  sessionId: string
  worldId: string
  rulebookId?: string
  moduleId?: string
  templateId?: string
  createdAt: number
  updatedAt: number
  updatedBy?: 'agent' | 'user'
}

export type CharacterPatch = Partial<
  Pick<CharacterBody, 'name' | 'concept' | 'player' | 'notes' | 'initialized'>
> & {
  attrs?: AttrValue[]
  skills?: Array<{ id: string; value: number | string; pending?: boolean; note?: string }>
  slots?: SlotEntry[]
  statuses?: StatusEffect[]
  journal?: JournalEntry[]
  removeAttrs?: string[]
  removeSkills?: string[]
  removeSlots?: string[]
  removeStatuses?: string[]
}

// ── 会话四元组 ─────────────────────────────────────────────────────────────

/** 一次冒险的完整配置：世界书 + 规则书 + 模组 + 角色卡。 */
export interface RunBinding {
  worldId?: string
  rulebookId?: string
  moduleId?: string
  /** 角色池中被导入的那一张。 */
  templateId?: string
  boundAt?: number
  startedAt?: number
}

export interface SessionBindingFile {
  v: 2
  sessions: Record<string, RunBinding>
}

export interface RunReport {
  world?: { id: string; name: string; fileCount: number; totalChars: number }
  rulebook?: { id: string; title: string; style: RuleStyle; system: string; baseDice: string; pitch?: string }
  module?: { id: string; name: string; tagline: string; scale?: string }
  character?: { name: string; concept?: string; initialized: boolean; templateId?: string }
  /** 还缺哪几环（按开局顺序）。 */
  missing: Array<'world' | 'rulebook' | 'module' | 'character'>
  ready: boolean
  next: string
}

// ── 骰子 ───────────────────────────────────────────────────────────────────

export interface DiceSpec {
  raw: string
  times: number
  sides: number
  modifier: number
  keep?: { mode: 'kh' | 'kl'; count: number }
  normalized: string
}

export interface RollRequest {
  expression?: string
  check?: string
  modifier?: number
  reason?: string
  difficulty?: number
  /** `value` 是**对手的目标值**（技能值）；留空则与玩家同目标。双方比较相对各自目标的余量。 */
  opposed?: { name: string; expression?: string; value?: number }
  action?: string
  actor?: 'player' | 'npc' | string
}

export interface DieFace {
  sides: number
  value: number
  kept: boolean
}

export interface RollSide {
  name: string
  spec: DiceSpec
  faces: DieFace[]
  sum: number
  modifier: number
  total: number
  target?: number
  /** 骰池结算：达标骰面数。 */
  successes?: number
}

export type RollOutcome = 'critical-success' | 'success' | 'failure' | 'critical-failure' | 'tie'

export interface RollResult {
  id: string
  ts: number
  actor?: string
  action?: string
  reason?: string
  check?: { id: string; label: string; attribute?: string; attributeValue?: number; skillValue?: number }
  direction: 'rollUnder' | 'rollOver'
  roll: RollSide
  opposed?: RollSide
  outcome: RollOutcome
  success: boolean
  difficultyLabel?: string
  margin?: number
  verdict: string
  consequences?: string[]
  rngSource: 'os' | 'seeded'
}

export interface DiceLedgerView {
  total: number
  recent: RollResult[]
}

// ── 路由载荷 ───────────────────────────────────────────────────────────────

export interface WhoAmI {
  ok: true
  sessionId: string
  preset?: string
  scorpio: boolean
  presetHint?: string
  unresolvable?: string
  cwd?: string
  stateDir?: string
  pluginVersion: string
}

/** 侧边栏「世界书」子页的一行：世界 + 它的规则书/模组/角色数量。 */
export interface WorldView extends World {
  rules: Rulebook[]
  modules: Array<Pick<Module, 'id' | 'name' | 'tagline' | 'scale' | 'updatedAt'>>;
  characterCount: number
}

export interface ScorpioSnapshot {
  ok: true
  who: WhoAmI
  worlds: WorldView[]
  /** 当前会话的四元组。 */
  binding: RunBinding
  /** 已解析的四元组 + 还缺什么。 */
  run: RunReport
  /** 会话中正在扮演的角色卡。 */
  character?: CharacterInstance
  /** 当前选定的规则书（含正文）。 */
  rulebook?: Rulebook & { markdown?: string; markdownMissing?: boolean }
  /** 当前选定的模组（含正文）。 */
  module?: Module & { markdown?: string; markdownMissing?: boolean }
  /** 当前世界的角色池。 */
  pool: CharacterTemplate[]
  /** 当前世界的全部模组（模组集子页用）。 */
  modules: Module[]
  dice: DiceLedgerView
  presetIds?: string[]
  serverTime: number
}

export interface LoadWorldBody {
  path: string
  name?: string
  listOnly?: boolean
  bind?: boolean
  sessionId?: string
}

export interface WriteRulebookBody {
  sessionId?: string
  worldId?: string
  /** 指定则覆盖同一套；不给则新建一套。 */
  rulebookId?: string
  style: RuleStyle
  title?: string
  pitch?: string
  markdown: string
  schema: RulesSchema
  path?: string
  /** 写入后选为当前会话的规则书（默认 true）。 */
  select?: boolean
}

export interface WriteModuleBody {
  sessionId?: string
  worldId?: string
  moduleId?: string
  name: string
  tagline: string
  markdown: string
  scale?: 'one-shot' | 'chapter' | 'campaign'
  players?: string
  tags?: string[]
  rulebookId?: string
  /** 写入后选为当前会话的模组（默认 true）。 */
  select?: boolean
}

export interface CharacterUpsertBody {
  sessionId?: string
  worldId?: string
  /** true=写入角色池（模板）；false=写入会话实例。 */
  pool?: boolean
  id?: string
  name?: string
  concept?: string
  player?: string
  attrs?: AttrValue[]
  skills?: Array<{ id: string; value: number | string; pending?: boolean; note?: string }>
  slots?: SlotEntry[]
  statuses?: StatusEffect[]
  journal?: JournalEntry[]
  notes?: string
  initialized?: boolean
  moduleId?: string
  rulebookId?: string
  generated?: boolean
  /** true=把这张模板导入当前会话成为扮演角色。 */
  select?: boolean
}

export interface BindRunBody {
  sessionId?: string
  worldId?: string
  rulebookId?: string
  moduleId?: string
  templateId?: string
}

export function emptyCharacterBody(): CharacterBody {
  return {
    name: '',
    attrs: [],
    skills: [],
    slots: [],
    statuses: [],
    journal: [],
    initialized: false,
  }
}

export function emptyInstance(sessionId: string, worldId: string, now = Date.now()): CharacterInstance {
  return {
    v: 2,
    sessionId,
    worldId,
    ...emptyCharacterBody(),
    createdAt: now,
    updatedAt: now,
  }
}

export const ROUTES = {
  health: '/scorpio/health',
  whoami: '/scorpio/whoami',
  snapshot: '/scorpio/snapshot',
  world: '/scorpio/world',
  worldFile: '/scorpio/world/file',
  rulebook: '/scorpio/rulebook',
  module: '/scorpio/module',
  character: '/scorpio/character',
  pool: '/scorpio/pool',
  run: '/scorpio/run',
  dice: '/scorpio/dice',
} as const
