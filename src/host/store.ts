/**
 * 工作区状态存储。
 *
 * 全部落在 `{workspace}/.scorpio/` 的明文 JSON 里，任何会话都可以用文件工具
 * 直接读取复盘；插件自身不引入任何二进制或隐藏索引。
 *
 *   .scorpio/worlds/index.json                世界书（世界观资料 + 文件清单）
 *   .scorpio/rules/index.json                 规则书，按世界分组：{ worldId: [Rulebook…] }
 *   .scorpio/modules/index.json               模组集，按世界分组：{ worldId: [Module…] }
 *   .scorpio/characters/index.json            角色池，按世界分组：{ worldId: [CharacterTemplate…] }
 *   .scorpio/characters/instances/{sid}.json  会话中正在扮演的角色卡
 *   .scorpio/session.json                     会话 → 四元组（world/rulebook/module/character）
 *   .scorpio/dice.jsonl                       判定流水（append-only）
 *
 * 世界书之外的产物（规则书 md、模组 md）写在工作区可见目录里，玩家能直接读改。
 *
 * v1 的旧结构（`.scorpio/worldbooks.json`、`.scorpio/rules/{bookId}.json`、
 * `.scorpio/characters/{sid}.json`）**不再被读取**：这是一次不兼容重构，旧文件
 * 保持原样留在磁盘上作为历史痕迹，不会污染新模型。
 */
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  CHARS_DIR,
  FILE_BINDING,
  FILE_DICE,
  MODULES_DIR,
  RULES_DIR,
  STATE_DIR,
  WORLDS_DIR,
  emptyCharacterBody,
  emptyInstance,
  type CharacterBody,
  type CharacterIndex,
  type CharacterInstance,
  type CharacterPatch,
  type CharacterTemplate,
  type DiceLedgerView,
  type Module,
  type ModuleIndex,
  type RollResult,
  type Rulebook,
  type RulesIndex,
  type RulesSchema,
  type RunBinding,
  type SessionBindingFile,
  type SlotEntry,
  type StatusEffect,
  type World,
  type WorldIndex,
} from '../shared/model.ts'
import { log } from './context.ts'
import { normalizeSchema } from './dice.ts'
import { resolveInside, resolveWorkspace } from './worldbook.ts'

const MAX_JOURNAL = 400
const MAX_SLOTS = 300
const MAX_STATUSES = 60
const MAX_ATTRS = 200
const MAX_SKILLS = 400

/**
 * 同一路径的写操作串行链。
 *
 * 临时文件名此前是 `${file}.tmp-${process.pid}-${Date.now()}`：同进程同毫秒的
 * 两个并发写会算出**同一个**临时路径，先完成者把它 rename 走，后者随即 ENOENT；
 * 两个 rename 交错时目标文件还会留下半截 JSON。实测（4 并发 upsert × 8 轮）
 * 该缺陷把整个世界书索引写坏，此前登记全部消失。因此 tmp 名带随机 UUID，
 * 且同一路径的写按 Promise 链排队。
 */
const writeChains = new Map<string, Promise<unknown>>()

function withPathLock<T>(file: string, task: () => Promise<T>): Promise<T> {
  const previous = writeChains.get(file) ?? Promise.resolve()
  const run = previous.then(task, task)
  writeChains.set(
    file,
    run.then(
      () => undefined,
      () => undefined,
    ),
  )
  return run
}

/** 读 JSON。解析失败时把坏文件另存为 `*.corrupt-<ts>` 而不是静默当空表。 */
async function readJson<T>(file: string, fallback: T): Promise<T> {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code !== 'ENOENT') log('readJson failed:', file, String(error))
    return fallback
  }
  if (raw.trim() === '') return fallback
  try {
    return JSON.parse(raw) as T
  } catch (error) {
    const backup = `${file}.corrupt-${Date.now().toString(36)}`
    try {
      await rename(file, backup)
      log(`readJson: ${file} 不是合法 JSON，已备份为 ${backup}（本次返回空表）`, String(error))
    } catch (renameError) {
      log('readJson: 坏文件备份失败', String(renameError))
    }
    return fallback
  }
}

/** 无锁写入（仅供已持有该路径锁的事务调用）。 */
async function writeJsonRaw(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(tmp, file)
}

async function writeTextRaw(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, file)
}

async function writeJson(file: string, value: unknown): Promise<void> {
  return withPathLock(file, () => writeJsonRaw(file, value))
}

async function writeText(file: string, text: string): Promise<void> {
  return withPathLock(file, () => writeTextRaw(file, text))
}

/**
 * 一次「读-改-写」事务：同一路径串行，因此不会丢失并发更新。
 * 这些索引文件都是 read-modify-write（读一次、改内存、整体覆盖写），
 * 只在写侧加锁仍是 last-writer-wins——必须把读也放进临界区。
 */
async function mutateJson<T>(file: string, fallback: T, fn: (draft: T) => T | Promise<T>): Promise<T> {
  return withPathLock(file, async () => {
    const draft = await readJson<T>(file, fallback)
    const next = await fn(draft)
    await writeJsonRaw(file, next)
    return next
  })
}

const clamp = (value: string | undefined, max: number): string | undefined => {
  if (value === undefined) return undefined
  const text = String(value)
  return text.length > max ? text.slice(0, max) : text
}

const posix = (value: string): string => value.split(/[/\\]/).join('/')

/** 由标题派生一个安全的 id 片段。 */
function slugTitle(title: string, suffix = ''): string {
  const base = String(title ?? '')
    .replace(suffix, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return base === '' ? (suffix === '规则书' ? 'rules' : 'item') : base
}

/** 工作区里所有 `.scorpio` 状态文件的入口。 */
export class ScorpioStore {
  private readonly workspace: string

  constructor(workspace: string) {
    this.workspace = workspace
  }

  private async root(): Promise<string> {
    return join(await resolveWorkspace(this.workspace), STATE_DIR)
  }

  private async file(name: string): Promise<string> {
    return join(await this.root(), name)
  }

  async workspaceRoot(): Promise<string> {
    return resolveWorkspace(this.workspace)
  }

  async stateDir(): Promise<string> {
    return this.root()
  }

  /** 生成一个在 taken 里不冲突的 id。 */
  suggestId(base: string, taken: readonly string[]): string {
    let id = base
    let n = 2
    while (taken.includes(id)) {
      id = `${base}-${n}`
      n += 1
    }
    return id
  }

  // ── 世界书 ───────────────────────────────────────────────────────────────

  async worldIndex(): Promise<WorldIndex> {
    const index = await readJson<WorldIndex>(await this.file(join(WORLDS_DIR, 'index.json')), { v: 2, worlds: [] })
    return {
      v: 2,
      worlds: Array.isArray(index.worlds) ? index.worlds : [],
      ...(index.activeId === undefined ? {} : { activeId: index.activeId }),
    }
  }

  async worlds(): Promise<World[]> {
    return (await this.worldIndex()).worlds
  }

  async world(worldId: string): Promise<World | undefined> {
    return (await this.worlds()).find((item) => item.id === worldId)
  }

  /** 载入/刷新一本世界书（同路径视为刷新，保留原 id）。 */
  async upsertWorld(world: World): Promise<World> {
    const file = await this.file(join(WORLDS_DIR, 'index.json'))
    let stored = world
    await mutateJson<WorldIndex>(file, { v: 2, worlds: [] }, (index) => {
      const existing = index.worlds.find((item) => item.id === world.id || item.path === world.path)
      if (existing !== undefined) {
        stored = { ...world, id: existing.id }
        index.worlds = index.worlds.filter((item) => item.id !== existing.id)
      } else if (index.worlds.some((item) => item.id === stored.id)) {
        stored = { ...stored, id: this.suggestId(stored.id, index.worlds.map((item) => item.id)) }
      }
      index.worlds.push(stored)
      index.activeId = stored.id
      return { ...index, v: 2 }
    })
    return stored
  }

  /** 移除一本世界书，并连带清掉它的规则书/模组/角色池条目（不动工作区原始资料）。 */
  async removeWorld(worldId: string): Promise<boolean> {
    const index = await this.worldIndex()
    const before = index.worlds.length
    index.worlds = index.worlds.filter((item) => item.id !== worldId)
    if (index.worlds.length === before) return false
    if (index.activeId === worldId) {
      const last = index.worlds[index.worlds.length - 1]
      if (last !== undefined) index.activeId = last.id
      else delete index.activeId
    }
    await writeJson(await this.file(join(WORLDS_DIR, 'index.json')), index)

    const rules = await this.rulesIndex()
    if (rules.byWorld[worldId] !== undefined) {
      delete rules.byWorld[worldId]
      await writeJson(await this.file(join(RULES_DIR, 'index.json')), rules)
    }
    const modules = await this.moduleIndex()
    if (modules.byWorld[worldId] !== undefined) {
      delete modules.byWorld[worldId]
      await writeJson(await this.file(join(MODULES_DIR, 'index.json')), modules)
    }
    const chars = await this.characterIndex()
    if (chars.byWorld[worldId] !== undefined) {
      delete chars.byWorld[worldId]
      await writeJson(await this.file(join(CHARS_DIR, 'index.json')), chars)
    }
    return true
  }

  async renameWorld(worldId: string, name: string): Promise<World | undefined> {
    const index = await this.worldIndex()
    const world = index.worlds.find((item) => item.id === worldId)
    if (world === undefined) return undefined
    world.name = clamp(name, 120) ?? world.id
    await writeJson(await this.file(join(WORLDS_DIR, 'index.json')), index)
    return world
  }

  // ── 规则书（一个世界多套） ────────────────────────────────────────────────

  async rulesIndex(): Promise<RulesIndex> {
    const index = await readJson<RulesIndex>(await this.file(join(RULES_DIR, 'index.json')), { v: 2, byWorld: {} })
    return { v: 2, byWorld: index?.byWorld ?? {} }
  }

  async rulesOf(worldId: string): Promise<Rulebook[]> {
    return (await this.rulesIndex()).byWorld[worldId] ?? []
  }

  async rulebook(worldId: string, rulebookId: string): Promise<Rulebook | undefined> {
    return (await this.rulesOf(worldId)).find((item) => item.id === rulebookId)
  }

  async firstRulebook(worldId: string): Promise<Rulebook | undefined> {
    return (await this.rulesOf(worldId))[0]
  }

  /**
   * 写一套规则书：校验 schema → 写工作区可见的 md → 登记索引。
   * 同一世界可以有多套：不给 rulebookId 就是新建一套，给了就是覆盖那一套。
   */
  async writeRulebook(input: {
    worldId: string
    rulebookId?: string
    title: string
    style: Rulebook['style']
    pitch?: string
    mdRel: string
    markdown: string
    schema: unknown
    editedBy: 'agent' | 'user'
  }): Promise<Rulebook> {
    const schema = normalizeSchema(input.schema)
    const index = await this.rulesIndex()
    const list = index.byWorld[input.worldId] ?? []
    const existing =
      input.rulebookId === undefined ? undefined : list.find((item) => item.id === input.rulebookId)
    const id = existing?.id ?? this.suggestId(slugTitle(input.title, '规则书'), list.map((item) => item.id))
    const mdAbs = await resolveInside(this.workspace, input.mdRel)
    await writeText(mdAbs, input.markdown)
    const entry: Rulebook = {
      id,
      worldId: input.worldId,
      title: input.title,
      style: input.style,
      ...(input.pitch === undefined ? {} : { pitch: clamp(input.pitch, 400) }),
      mdPath: posix(input.mdRel),
      schema,
      writtenAt: Date.now(),
      editedBy: input.editedBy,
    }
    index.byWorld[input.worldId] = [...list.filter((item) => item.id !== id), entry]
    await writeJson(await this.file(join(RULES_DIR, 'index.json')), index)
    await this.reconcilePoolFor(input.worldId, entry)
    return entry
  }

  async removeRulebook(worldId: string, rulebookId: string): Promise<boolean> {
    const index = await this.rulesIndex()
    const list = index.byWorld[worldId] ?? []
    const next = list.filter((item) => item.id !== rulebookId)
    if (next.length === list.length) return false
    if (next.length === 0) delete index.byWorld[worldId]
    else index.byWorld[worldId] = next
    await writeJson(await this.file(join(RULES_DIR, 'index.json')), index)
    return true
  }

  /** 用某套规则重建匹配它的角色池条目（保留已有取值）。 */
  private async reconcilePoolFor(worldId: string, rulebook: Rulebook): Promise<void> {
    const index = await this.characterIndex()
    const list = index.byWorld[worldId] ?? []
    let touched = false
    index.byWorld[worldId] = list.map((item) => {
      if (item.rulebookId !== undefined && item.rulebookId !== rulebook.id) return item
      const { body, changed } = reconcileBody(item, rulebook.schema)
      if (!changed) return item
      touched = true
      return { ...item, ...body, updatedAt: Date.now() }
    })
    if (touched) await writeJson(await this.file(join(CHARS_DIR, 'index.json')), index)
  }

  async readRulebookMarkdown(rule: Rulebook): Promise<{ text: string; path: string; missing: boolean }> {
    return this.readMarkdownAt(rule.mdPath)
  }

  /** 规则书/模组正文的 mtime 缓存：snapshot 每 8 秒轮询一次，未改动时不必重读磁盘。 */
  private readonly markdownCache = new Map<string, { stamp: string; text: string }>()

  private async readMarkdownAt(rel: string): Promise<{ text: string; path: string; missing: boolean }> {
    try {
      const abs = await resolveInside(this.workspace, rel)
      const info = await stat(abs)
      if (!info.isFile()) return { text: '', path: rel, missing: true }
      const stamp = `${info.mtimeMs}:${info.size}`
      const cached = this.markdownCache.get(abs)
      if (cached !== undefined && cached.stamp === stamp) return { text: cached.text, path: rel, missing: false }
      const text = await readFile(abs, 'utf8')
      this.markdownCache.set(abs, { stamp, text })
      if (this.markdownCache.size > 64) this.markdownCache.clear()
      return { text, path: rel, missing: false }
    } catch (error) {
      log('readMarkdownAt failed:', rel, String(error))
      return { text: '', path: rel, missing: true }
    }
  }

  // ── 模组集 ───────────────────────────────────────────────────────────────

  async moduleIndex(): Promise<ModuleIndex> {
    const index = await readJson<ModuleIndex>(await this.file(join(MODULES_DIR, 'index.json')), { v: 2, byWorld: {} })
    return { v: 2, byWorld: index?.byWorld ?? {} }
  }

  async modulesOf(worldId: string): Promise<Module[]> {
    return (await this.moduleIndex()).byWorld[worldId] ?? []
  }

  async module(worldId: string, moduleId: string): Promise<Module | undefined> {
    return (await this.modulesOf(worldId)).find((item) => item.id === moduleId)
  }

  async writeModule(input: {
    worldId: string
    moduleId?: string
    name: string
    tagline: string
    mdRel: string
    markdown: string
    scale?: Module['scale']
    players?: string
    tags?: string[]
    rulebookId?: string
    source: 'agent' | 'user'
  }): Promise<Module> {
    const index = await this.moduleIndex()
    const list = index.byWorld[input.worldId] ?? []
    const existing =
      input.moduleId === undefined ? undefined : list.find((item) => item.id === input.moduleId)
    const id = existing?.id ?? this.suggestId(slugTitle(input.name, '模组'), list.map((item) => item.id))
    const mdAbs = await resolveInside(this.workspace, input.mdRel)
    await writeText(mdAbs, input.markdown)
    const now = Date.now()
    const entry: Module = {
      id,
      worldId: input.worldId,
      ...(input.rulebookId === undefined ? {} : { rulebookId: input.rulebookId }),
      name: clamp(input.name, 120) ?? id,
      tagline: clamp(input.tagline, 300) ?? '',
      mdPath: posix(input.mdRel),
      ...(input.scale === undefined ? {} : { scale: input.scale }),
      ...(input.players === undefined ? {} : { players: clamp(input.players, 80) }),
      ...(input.tags === undefined ? {} : { tags: input.tags.slice(0, 12).map((tag) => String(tag).slice(0, 24)) }),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      source: input.source,
    }
    index.byWorld[input.worldId] = [...list.filter((item) => item.id !== id), entry]
    await writeJson(await this.file(join(MODULES_DIR, 'index.json')), index)
    return entry
  }

  async removeModule(worldId: string, moduleId: string): Promise<boolean> {
    const index = await this.moduleIndex()
    const list = index.byWorld[worldId] ?? []
    const next = list.filter((item) => item.id !== moduleId)
    if (next.length === list.length) return false
    if (next.length === 0) delete index.byWorld[worldId]
    else index.byWorld[worldId] = next
    await writeJson(await this.file(join(MODULES_DIR, 'index.json')), index)
    return true
  }

  async readModuleMarkdown(module: Module): Promise<{ text: string; path: string; missing: boolean }> {
    return this.readMarkdownAt(module.mdPath)
  }

  // ── 角色卡：角色池 ───────────────────────────────────────────────────────

  async characterIndex(): Promise<CharacterIndex> {
    const index = await readJson<CharacterIndex>(await this.file(join(CHARS_DIR, 'index.json')), { v: 2, byWorld: {} })
    return { v: 2, byWorld: index?.byWorld ?? {} }
  }

  async pool(worldId: string): Promise<CharacterTemplate[]> {
    return (await this.characterIndex()).byWorld[worldId] ?? []
  }

  async template(worldId: string, templateId: string): Promise<CharacterTemplate | undefined> {
    return (await this.pool(worldId)).find((item) => item.id === templateId)
  }

  /** 写入角色池（`rulebook` 给定时按它的 schema 补齐属性/技能条目）。 */
  async saveTemplate(
    input: {
      worldId: string
      templateId?: string
      body: CharacterBody
      rulebookId?: string
      moduleId?: string
      generated?: boolean
      source: 'agent' | 'user'
    },
    rulebook?: Rulebook,
  ): Promise<CharacterTemplate> {
    const index = await this.characterIndex()
    const list = index.byWorld[input.worldId] ?? []
    const existing =
      input.templateId === undefined ? undefined : list.find((item) => item.id === input.templateId)
    const id =
      existing?.id ??
      this.suggestId(slugTitle(input.body.name || '角色'), list.map((item) => item.id))
    const now = Date.now()
    let body = sanitizeBody(input.body)
    if (rulebook !== undefined) body = reconcileBody(body, rulebook.schema).body
    const entry: CharacterTemplate = {
      ...body,
      id,
      worldId: input.worldId,
      ...(input.rulebookId === undefined ? {} : { rulebookId: input.rulebookId }),
      ...(input.moduleId === undefined ? {} : { moduleId: input.moduleId }),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      source: input.source,
      ...(input.generated === true ? { generated: true } : {}),
    }
    index.byWorld[input.worldId] = [...list.filter((item) => item.id !== id), entry]
    await writeJson(await this.file(join(CHARS_DIR, 'index.json')), index)
    return entry
  }

  async removeTemplate(worldId: string, templateId: string): Promise<boolean> {
    const index = await this.characterIndex()
    const list = index.byWorld[worldId] ?? []
    const next = list.filter((item) => item.id !== templateId)
    if (next.length === list.length) return false
    if (next.length === 0) delete index.byWorld[worldId]
    else index.byWorld[worldId] = next
    await writeJson(await this.file(join(CHARS_DIR, 'index.json')), index)
    return true
  }

  // ── 角色卡：会话实例 ─────────────────────────────────────────────────────

  private async instanceFile(sessionId: string): Promise<string> {
    return this.file(join(CHARS_DIR, 'instances', `${sessionId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`))
  }

  /** 读会话实例；不存在则按规则书建一张空的（并按 schema 铺好属性/技能）。 */
  async instance(sessionId: string, worldId: string, rulebook?: Rulebook): Promise<CharacterInstance> {
    if (typeof sessionId !== 'string' || sessionId === '') throw new Error('缺少 sessionId')
    const file = await this.instanceFile(sessionId)
    const loaded = await readJson<CharacterInstance | undefined>(file, undefined)
    if (loaded === undefined || typeof loaded !== 'object' || loaded.v !== 2) {
      const fresh = emptyInstance(sessionId, worldId)
      const body =
        rulebook === undefined ? fresh : { ...fresh, ...reconcileBody(fresh, rulebook.schema).body }
      const instance: CharacterInstance = { ...body, v: 2, sessionId, worldId }
      await writeJson(file, instance)
      return instance
    }
    if (rulebook === undefined) return loaded
    const { body } = reconcileBody(loaded, rulebook.schema)
    return { ...loaded, ...body }
  }

  /** 把角色池的一张模板导入会话，成为本次扮演的角色卡。 */
  async importTemplate(
    sessionId: string,
    template: CharacterTemplate,
    extra: { rulebookId?: string; moduleId?: string },
  ): Promise<CharacterInstance> {
    const now = Date.now()
    const instance: CharacterInstance = {
      ...sanitizeBody(template),
      v: 2,
      sessionId,
      worldId: template.worldId,
      templateId: template.id,
      ...(extra.rulebookId === undefined ? {} : { rulebookId: extra.rulebookId }),
      ...(extra.moduleId === undefined ? {} : { moduleId: extra.moduleId }),
      createdAt: now,
      updatedAt: now,
      updatedBy: 'user',
    }
    await writeJson(await this.instanceFile(sessionId), instance)
    return instance
  }

  async saveInstance(instance: CharacterInstance, editedBy: 'agent' | 'user'): Promise<CharacterInstance> {
    const body = sanitizeBody(instance)
    const next: CharacterInstance = { ...instance, ...body, v: 2, updatedAt: Date.now(), updatedBy: editedBy }
    await writeJson(await this.instanceFile(next.sessionId), next)
    return next
  }

  async patchInstance(
    sessionId: string,
    worldId: string,
    patch: CharacterPatch,
    editedBy: 'agent' | 'user',
    rulebook?: Rulebook,
  ): Promise<CharacterInstance> {
    const instance = await this.instance(sessionId, worldId, rulebook)
    const next: CharacterInstance = { ...instance, ...applyPatch(instance, patch) }
    return this.saveInstance(next, editedBy)
  }

  // ── 会话四元组 ───────────────────────────────────────────────────────────

  async bindings(): Promise<SessionBindingFile> {
    const data = await readJson<SessionBindingFile>(await this.file(FILE_BINDING), { v: 2, sessions: {} })
    return { v: 2, sessions: data?.sessions ?? {} }
  }

  async binding(sessionId: string): Promise<RunBinding> {
    const data = await this.bindings()
    return data.sessions[sessionId] ?? {}
  }

  /** 增量设置四元组：字段给 `undefined` 表示不动，给 `null` 表示清空。 */
  async bindRun(
    sessionId: string,
    patch: {
      worldId?: string | null
      rulebookId?: string | null
      moduleId?: string | null
      templateId?: string | null
      startedAt?: number
    },
  ): Promise<RunBinding> {
    if (typeof sessionId !== 'string' || sessionId === '') throw new Error('缺少 sessionId')
    const file = await this.file(FILE_BINDING)
    let result: RunBinding = {}
    await mutateJson<SessionBindingFile>(file, { v: 2, sessions: {} }, (data) => {
      const current: RunBinding = data.sessions[sessionId] ?? {}
      const next: RunBinding = { ...current, boundAt: Date.now() }
      const put = (key: keyof RunBinding, value: string | null | undefined): void => {
        if (value === undefined) return
        if (value === null) delete next[key]
        else (next as Record<string, unknown>)[key] = value
      }
      // 换世界时先清掉属于旧世界的选择，避免出现跨世界的四元组。
      if (patch.worldId !== undefined && patch.worldId !== null && patch.worldId !== current.worldId) {
        delete next.rulebookId
        delete next.moduleId
        delete next.templateId
      }
      put('worldId', patch.worldId)
      put('rulebookId', patch.rulebookId)
      put('moduleId', patch.moduleId)
      put('templateId', patch.templateId)
      if (patch.startedAt !== undefined) next.startedAt = patch.startedAt
      data.sessions[sessionId] = next
      result = next
      return { ...data, v: 2 }
    })
    return result
  }

  async unbind(sessionId: string): Promise<boolean> {
    const data = await this.bindings()
    if (data.sessions[sessionId] === undefined) return false
    delete data.sessions[sessionId]
    await writeJson(await this.file(FILE_BINDING), data)
    return true
  }

  // ── 骰子流水 ─────────────────────────────────────────────────────────────

  async appendRoll(result: RollResult): Promise<void> {
    const file = await this.file(FILE_DICE)
    await mkdir(dirname(file), { recursive: true })
    await appendFile(file, `${JSON.stringify({ v: 1, entry: result })}\n`, 'utf8')
  }

  async diceLedger(limit = 50): Promise<DiceLedgerView> {
    const file = await this.file(FILE_DICE)
    let raw = ''
    try {
      raw = await readFile(file, 'utf8')
    } catch {
      return { total: 0, recent: [] }
    }
    const lines = raw.split('\n').filter((line) => line.trim() !== '')
    const recent: RollResult[] = []
    const want = Math.max(1, Math.min(200, limit))
    // 只解析尾部 want 行：以前对整份流水逐行 JSON.parse，长战役下每次轮询都要付全额成本。
    for (let i = lines.length - 1; i >= 0 && recent.length < want; i -= 1) {
      const line = lines[i]
      if (line === undefined) continue
      try {
        const parsed = JSON.parse(line) as { entry?: RollResult }
        if (parsed.entry !== undefined) recent.push(parsed.entry)
      } catch {
        /* 跳过损坏行 */
      }
    }
    return { total: lines.length, recent }
  }

  /** 诊断用：列出已存在的会话实例文件名。 */
  async instanceIds(): Promise<string[]> {
    try {
      const dir = join(await this.root(), CHARS_DIR, 'instances')
      return (await readdir(dir)).filter((name) => name.endsWith('.json')).map((name) => name.replace(/\.json$/, ''))
    } catch {
      return []
    }
  }
}

/** 裁剪与规整角色卡主体（所有写入路径共用）。 */
export function sanitizeBody(body: CharacterBody): CharacterBody {
  return {
    name: clamp(body.name, 120) ?? '',
    concept: clamp(body.concept, 240),
    player: clamp(body.player, 120),
    attrs: (body.attrs ?? []).slice(0, MAX_ATTRS),
    skills: (body.skills ?? []).slice(0, MAX_SKILLS),
    slots: (body.slots ?? []).slice(0, MAX_SLOTS),
    statuses: (body.statuses ?? []).slice(0, MAX_STATUSES),
    journal: (body.journal ?? []).slice(-MAX_JOURNAL),
    notes: clamp(body.notes, 4000),
    initialized: body.initialized === true,
  }
}

/**
 * 用规则 schema 补齐属性与技能条目（保留已有取值）。
 * 缺 base 的属性标为待确认，让玩家自己填。
 */
export function reconcileBody(
  body: CharacterBody,
  schema: RulesSchema,
): { body: CharacterBody; changed: boolean } {
  const attrs = [...(body.attrs ?? [])]
  const skills = [...(body.skills ?? [])]
  let changed = false
  for (const def of schema.attributes ?? []) {
    if (attrs.some((item) => item.id === def.id)) continue
    attrs.push({ id: def.id, value: def.base ?? 0, ...(def.base === undefined ? { pending: true } : {}) })
    changed = true
  }
  for (const def of schema.skills ?? []) {
    if (skills.some((item) => item.id === def.id)) continue
    skills.push({ id: def.id, value: 0, pending: true })
    changed = true
  }
  const attrIds = new Set((schema.attributes ?? []).map((item) => item.id))
  const skillIds = new Set((schema.skills ?? []).map((item) => item.id))
  if (attrs.some((item) => !attrIds.has(item.id))) changed = true
  if (skills.some((item) => !skillIds.has(item.id))) changed = true
  return {
    body: {
      ...body,
      attrs: attrs.filter((item) => attrIds.has(item.id)),
      skills: skills.filter((item) => skillIds.has(item.id)),
    },
    changed,
  }
}

/** 增量补丁：属性/技能按 id upsert，槽位/状态/日志按 id 合并或追加。 */
export function applyPatch(body: CharacterBody, patch: CharacterPatch): Partial<CharacterBody> {
  const out: Partial<CharacterBody> = {}
  if (patch.name !== undefined) out.name = clamp(patch.name, 120) ?? body.name
  if (patch.player !== undefined) out.player = clamp(patch.player, 120)
  if (patch.concept !== undefined) out.concept = clamp(patch.concept, 240)
  if (patch.notes !== undefined) out.notes = clamp(patch.notes, 4000)
  if (patch.initialized !== undefined) out.initialized = patch.initialized === true

  if (patch.attrs !== undefined) {
    const attrs = [...body.attrs]
    for (const attr of patch.attrs) {
      const existing = attrs.find((item) => item.id === attr.id)
      if (existing === undefined) attrs.push(attr)
      else {
        existing.value = attr.value
        existing.pending = attr.pending === true
        if (attr.note !== undefined) existing.note = clamp(attr.note, 400)
        if (attr.max !== undefined) existing.max = attr.max
      }
    }
    out.attrs = attrs
  }
  if (patch.skills !== undefined) {
    const skills = [...body.skills]
    for (const skill of patch.skills) {
      const existing = skills.find((item) => item.id === skill.id)
      if (existing === undefined) skills.push(skill)
      else {
        existing.value = skill.value
        existing.pending = skill.pending === true
        if (skill.note !== undefined) existing.note = clamp(skill.note, 400)
      }
    }
    out.skills = skills
  }
  if (patch.slots !== undefined) {
    const slots = [...body.slots]
    for (const slot of patch.slots) {
      const existing = slots.find((item) => item.id === slot.id)
      if (existing === undefined) slots.push(slot)
      else Object.assign(existing, slot)
    }
    out.slots = slots
  }
  if (patch.statuses !== undefined) {
    const statuses = [...body.statuses]
    for (const status of patch.statuses) {
      const existing = statuses.find((item) => item.id === status.id)
      if (existing === undefined) statuses.push(status)
      else Object.assign(existing, status)
    }
    out.statuses = statuses
  }
  if (patch.journal !== undefined) {
    const journal = [...body.journal]
    for (const entry of patch.journal) {
      if (journal.some((item) => item.id === entry.id)) continue
      journal.push({
        id: entry.id,
        ts: entry.ts ?? Date.now(),
        title: clamp(entry.title, 160) ?? '记录',
        ...(entry.text === undefined ? {} : { text: clamp(entry.text, 2000) }),
        by: entry.by ?? 'agent',
      })
    }
    out.journal = journal
  }
  if (patch.removeAttrs !== undefined) {
    out.attrs = (out.attrs ?? body.attrs).filter((item) => !patch.removeAttrs?.includes(item.id))
  }
  if (patch.removeSkills !== undefined) {
    out.skills = (out.skills ?? body.skills).filter((item) => !patch.removeSkills?.includes(item.id))
  }
  if (patch.removeSlots !== undefined) {
    out.slots = (out.slots ?? body.slots).filter((item) => !patch.removeSlots?.includes(item.id))
  }
  if (patch.removeStatuses !== undefined) {
    out.statuses = (out.statuses ?? body.statuses).filter((item) => !patch.removeStatuses?.includes(item.id))
  }
  return out
}

/** 空槽位（侧边栏「+ 添加」用）。 */
export function newSlot(kind: SlotEntry['kind'], index: number): SlotEntry {
  return { id: `${kind}-${Date.now().toString(36)}-${index}`, name: '', kind, qty: 1, active: true }
}

/** 新状态效果。 */
export function newStatus(index: number): StatusEffect {
  return { id: `status-${Date.now().toString(36)}-${index}`, label: '新状态', kind: 'neutral' }
}

/** 一份空角色主体。 */
export function blankBody(): CharacterBody {
  return emptyCharacterBody()
}
