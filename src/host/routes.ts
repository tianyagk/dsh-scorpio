/**
 * /scorpio/* 同源 HTTP 路由：浏览器半区（betterSidebar 页签 + 悬浮判定卡）唯一的
 * 取数与写入口。
 *
 *  GET  — health / whoami / snapshot / world(清单) / world/file / rulebook / module /
 *         character / pool / dice
 *  POST — world(载入·改名·删除) / rulebook(写一套) / module(写一个) /
 *         character(存池·存实例·导入) / pool(删一张) / run(设四元组) / dice(掷骰)
 *
 * 全部路由在浏览器信任围栏之后；写操作还要求同源 Origin。会话不属于天蝎座预设时
 * 一律 403 —— 页面本身就只在天蝎座会话里渲染，这道判断是第二道闸。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  MAX_BODY,
  MAX_EDIT_CHARS,
  PLUGIN_ID,
  PRESET_ID,
  ROUTES,
  RULE_STYLES,
  VERSION,
  emptyCharacterBody,
  ruleStyleInfo,
  slugify,
  type BindRunBody,
  type CharacterBody,
  type CharacterUpsertBody,
  type LoadWorldBody,
  type RollRequest,
  type RollResult,
  type RunReport,
  type RuleStyle,
  type WriteModuleBody,
  type WriteRulebookBody,
  type WhoAmI,
} from '../shared/model.ts'
import { performRoll } from './dice.ts'
import { isTrustedApiRequest } from './fence.ts'
import { ScorpioStore } from './store.ts'
import {
  PathFenceError,
  readWorldbookFile,
  resolveSessionPreset,
  scanWorldbook,
} from './worldbook.ts'
import { log, type PluginContext, type PluginWebRoute, type PluginWebServer } from './context.ts'

export interface ScorpioRoutesDeps {
  ctx: PluginContext
  storeFor(workspace: string): ScorpioStore
}

const send = (res: ServerResponse, code: number, payload: unknown): void => {
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(payload))
}

const queryOf = (req: IncomingMessage): URLSearchParams =>
  new URL(req.url ?? '/', 'http://localhost').searchParams

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buf.length
    if (size > MAX_BODY) throw new Error('请求体过大')
    chunks.push(buf)
  }
  if (size === 0) return {}
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('请求体必须是 JSON 对象')
  }
  return parsed as Record<string, unknown>
}

const asString = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : value === undefined || value === null ? fallback : String(value)

const asBool = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback

export function makeScorpioRoutes(deps: ScorpioRoutesDeps): {
  routes: PluginWebRoute[]
  register(server: PluginWebServer): () => void
} {
  const trusted = deps.ctx.get('webRuntime')?.trustedHosts ?? []
  const presetCache = new Map<string, { at: number; preset?: string; cwd?: string }>()

  const resolvePreset = async (sessionId: string): Promise<{ preset?: string; cwd?: string }> => {
    const cached = presetCache.get(sessionId)
    if (cached !== undefined && Date.now() - cached.at < 3000) {
      return { preset: cached.preset, cwd: cached.cwd }
    }
    const info = await resolveSessionPreset(deps.ctx, sessionId)
    presetCache.set(sessionId, { at: Date.now(), ...info })
    if (presetCache.size > 200) {
      const oldest = [...presetCache.entries()].sort((a, b) => a[1].at - b[1].at)[0]
      if (oldest !== undefined) presetCache.delete(oldest[0])
    }
    return info
  }

  /** 名册里现在有哪些预设（用于判断会话记录的预设是否已被删除）。 */
  const rosterIds = async (): Promise<string[] | undefined> => {
    const presets = deps.ctx.get('agentPresets')
    if (presets === undefined) return undefined
    try {
      return (await presets.list()).map((item) => item.id)
    } catch (error) {
      log('agentPresets.list failed:', String(error))
      return undefined
    }
  }

  const presetIssue = async (preset: string | undefined): Promise<string | undefined> => {
    if (typeof preset !== 'string' || preset === '') return undefined
    const ids = await rosterIds()
    if (ids === undefined || ids.includes(preset)) return undefined
    return (
      `这个会话记录的 Agent 预设「${preset}」已经不在名册里（现有：${ids.join('、')}）。` +
      '该会话无法切换预设——切换会尝试恢复一个已不存在的预设并失败；请新建一个会话，' +
      '在「Agent 预设」里选择「天蝎座 Scorpio」。'
    )
  }

  /**
   * 产物落盘路径的**职责边界**：只允许写插件自己的产物。
   * 仅靠 `resolveInside` 只有"工作区边界"——实测能覆盖世界书源文件
   * （corpus/xxx.md）与会话绑定（.scorpio/session.json），因此这里再收一层：
   * 拒绝 `.scorpio/` 前缀、拒绝 `..` 组件、要求 `.md`、拒绝落在任何已登记世界书目录内。
   */
  const artifactRel = async (store: ScorpioStore, rel: string, fallback: string): Promise<string> => {
    const target = (rel.trim() === '' ? fallback : rel.trim()).replace(/\\+/g, '/').replace(/^\.\//, '')
    if (target.startsWith('.scorpio/') || target === '.scorpio') {
      throw new PathFenceError('产物不能写入 .scorpio/ 状态目录')
    }
    if (target.startsWith('/') || target.split('/').includes('..')) {
      throw new PathFenceError('产物路径不能是绝对路径、也不能包含 ..')
    }
    if (!/\.md$/i.test(target)) throw new PathFenceError('产物必须是 .md 文件')
    for (const world of await store.worlds()) {
      if (world.path === '') continue
      if (target === world.path || target.startsWith(`${world.path}/`)) {
        throw new PathFenceError(`产物不能写入世界书目录 ${world.path}/（那是玩家的源资料）`)
      }
    }
    return target
  }

  const gate = (req: IncomingMessage): boolean => isTrustedApiRequest(req, trusted)
  const sameOrigin = (req: IncomingMessage): boolean => {
    const origin = req.headers.origin
    const host = req.headers.host
    if (typeof origin !== 'string' || typeof host !== 'string') return true
    try {
      return new URL(origin).host === host
    } catch {
      return false
    }
  }
  const fail = (res: ServerResponse, error: unknown, code = 400): void => {
    const message = error instanceof Error ? error.message : String(error)
    if (code >= 500) log('route error:', message)
    send(res, code, { ok: false, error: message })
  }

  /** 会话 → 工作区；非天蝎座会话一律挡在门外。 */
  const scoped = async (
    res: ServerResponse,
    sessionId: string,
  ): Promise<{ cwd: string; preset: string } | undefined> => {
    if (sessionId === '') {
      fail(res, new Error('缺少 sessionId'), 400)
      return undefined
    }
    const info = await resolvePreset(sessionId)
    if (info.preset === undefined || info.preset === '') {
      fail(res, new Error('无法解析该会话的 Agent 预设（会话可能已归档）'), 403)
      return undefined
    }
    if (info.preset !== PRESET_ID) {
      fail(
        res,
        new Error(
          (await presetIssue(info.preset)) ??
            `当前会话的预设是「${info.preset}」，不是天蝎座 Scorpio。请新建会话并在「Agent 预设」里选择「天蝎座 Scorpio」。`,
        ),
        403,
      )
      return undefined
    }
    if (typeof info.cwd !== 'string' || info.cwd === '') {
      fail(res, new Error('该会话没有工作区（cwd），请先选择工作区'), 409)
      return undefined
    }
    return { cwd: info.cwd, preset: info.preset }
  }

  /**
   * 解析「当前世界」：优先请求里显式给的 worldId，其次会话绑定，最后该工作区唯一的
   * 那本世界书（只有一本时自动采用，减少无谓的选择步骤）。
   */
  const currentWorldId = async (
    store: ScorpioStore,
    sessionId: string,
    explicit?: string,
  ): Promise<string | undefined> => {
    if (explicit !== undefined && explicit !== '') return explicit
    const binding = await store.binding(sessionId)
    if (binding.worldId !== undefined) return binding.worldId
    const worlds = await store.worlds()
    return worlds.length === 1 ? worlds[0]?.id : undefined
  }

  /** 组织「当前四元组」的解析结果，供 snapshot 与 scorpio_run 共用。 */
  const buildRun = async (store: ScorpioStore, sessionId: string): Promise<{
    run: RunReport
    binding: Awaited<ReturnType<ScorpioStore['binding']>>
    world?: Awaited<ReturnType<ScorpioStore['world']>>
    rulebook?: Awaited<ReturnType<ScorpioStore['rulebook']>>
    module?: Awaited<ReturnType<ScorpioStore['module']>>
    character?: Awaited<ReturnType<ScorpioStore['instance']>>
  }> => {
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
    const instance =
      world === undefined ? undefined : await store.instance(sessionId, world.id, rulebook)
    const missing: RunReport['missing'] = []
    if (world === undefined) missing.push('world')
    if (rulebook === undefined) missing.push('rulebook')
    if (module === undefined) missing.push('module')
    if (instance === undefined || instance.name === '' || instance.name === undefined) missing.push('character')
    const next =
      world === undefined
        ? '① 载入世界书（侧边栏「世界书」或 scorpio_worldbook action=load path=<目录>）'
        : rulebook === undefined
          ? `② 为《${world.name}》生成一套规则书（scorpio_worldbook action=write_rulebook，style 选 d100 / d20 / d6pool）`
          : module === undefined
            ? '③ 生成或挑选一个模组（scorpio_module action=generate / list / select）'
            : instance === undefined || instance.name === ''
              ? '④ 生成或挑选一张角色卡（scorpio_character action=generate / list / select）'
              : '⑤ 四元组齐备：可以开演。每次重要行动先调用 scorpio_roll。'
    const run: RunReport = {
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
    }
    return {
      run,
      binding,
      ...(world === undefined ? {} : { world }),
      ...(rulebook === undefined ? {} : { rulebook }),
      ...(module === undefined ? {} : { module }),
      ...(instance === undefined ? {} : { character: instance }),
    }
  }

  const routes: PluginWebRoute[] = []

  // ── health ────────────────────────────────────────────────────────────────
  routes.push({
    kind: 'exact',
    path: ROUTES.health,
    handler: (req, res) => {
      if (!gate(req)) return send(res, 403, { ok: false, error: 'forbidden' })
      send(res, 200, { ok: true, name: PLUGIN_ID, version: VERSION, preset: PRESET_ID, time: Date.now() })
    },
  })

  // ── whoami：页签与悬浮卡据此决定是否渲染 ───────────────────────────────────
  routes.push({
    kind: 'exact',
    path: ROUTES.whoami,
    handler: async (req, res) => {
      if (!gate(req)) return send(res, 403, { ok: false, error: 'forbidden' })
      try {
        const sessionId = asString(queryOf(req).get('sessionId'))
        if (sessionId === '') return fail(res, new Error('缺少 sessionId'))
        const info = await resolvePreset(sessionId)
        const unresolvable = await presetIssue(info.preset)
        const payload: WhoAmI = {
          ok: true,
          sessionId,
          ...(info.preset === undefined ? {} : { preset: info.preset }),
          scorpio: info.preset === PRESET_ID,
          ...(info.cwd === undefined ? {} : { cwd: info.cwd }),
          ...(unresolvable === undefined ? {} : { unresolvable }),
          pluginVersion: VERSION,
        }
        send(res, 200, payload)
      } catch (error) {
        fail(res, error)
      }
    },
  })

  // ── snapshot：一次拉齐三个子页 + 悬浮卡需要的一切 ───────────────────────────
  routes.push({
    kind: 'exact',
    path: ROUTES.snapshot,
    handler: async (req, res) => {
      if (!gate(req)) return send(res, 403, { ok: false, error: 'forbidden' })
      try {
        const sessionId = asString(queryOf(req).get('sessionId'))
        const bound = await scoped(res, sessionId)
        if (bound === undefined) return
        const store = deps.storeFor(bound.cwd)
        const worlds = await store.worlds()
        const views = []
        for (const world of worlds) {
          const rules = await store.rulesOf(world.id)
          const modules = await store.modulesOf(world.id)
          const pool = await store.pool(world.id)
          views.push({
            ...world,
            rules,
            modules: modules.map((item) => ({
              id: item.id,
              name: item.name,
              tagline: item.tagline,
              ...(item.scale === undefined ? {} : { scale: item.scale }),
              updatedAt: item.updatedAt,
            })),
            characterCount: pool.length,
          })
        }
        const { run, binding, rulebook, module, character } = await buildRun(store, sessionId)
        const ruleText =
          rulebook === undefined ? undefined : await store.readRulebookMarkdown(rulebook)
        const moduleText =
          module === undefined ? undefined : await store.readModuleMarkdown(module)
        const pool = binding.worldId === undefined ? [] : await store.pool(binding.worldId)
        const modules = binding.worldId === undefined ? [] : await store.modulesOf(binding.worldId)
        const dice = await store.diceLedger(60)
        const presetIds = await rosterIds()
        send(res, 200, {
          ok: true,
          who: {
            ok: true,
            sessionId,
            preset: bound.preset,
            scorpio: true,
            cwd: bound.cwd,
            stateDir: await store.stateDir(),
            pluginVersion: VERSION,
          } satisfies WhoAmI,
          worlds: views,
          binding,
          run,
          ...(character === undefined ? {} : { character }),
          ...(rulebook === undefined
            ? {}
            : {
                rulebook: {
                  ...rulebook,
                  markdown: ruleText?.text ?? '',
                  markdownMissing: ruleText?.missing ?? false,
                },
              }),
          ...(module === undefined
            ? {}
            : {
                module: {
                  ...module,
                  markdown: moduleText?.text ?? '',
                  markdownMissing: moduleText?.missing ?? false,
                },
              }),
          pool,
          modules,
          dice,
          ...(presetIds === undefined ? {} : { presetIds }),
          serverTime: Date.now(),
        })
      } catch (error) {
        fail(res, error, error instanceof PathFenceError ? 400 : 500)
      }
    },
  })

  // ── world：世界书清单 / 载入全文 / 改名 / 移除 ──────────────────────────────
  routes.push({
    kind: 'exact',
    path: ROUTES.world,
    handler: async (req, res) => {
      if (!gate(req)) return send(res, 403, { ok: false, error: 'forbidden' })
      try {
        if (req.method === 'GET') {
          const q = queryOf(req)
          const sessionId = asString(q.get('sessionId'))
          const bound = await scoped(res, sessionId)
          if (bound === undefined) return
          const store = deps.storeFor(bound.cwd)
          const worldId = asString(q.get('worldId')) || (await store.binding(sessionId)).worldId || ''
          const world = worldId === '' ? undefined : await store.world(worldId)
          const withText = q.get('text') === '1'
          if (world === undefined) return send(res, 200, { ok: true, world: null })
          const files = withText
            ? (await scanWorldbook(bound.cwd, world.path)).files
            : world.files
          send(res, 200, { ok: true, world: { ...world, files } })
          return
        }
        if (req.method !== 'POST') return fail(res, new Error('不支持的方法'), 405)
        if (!sameOrigin(req)) return fail(res, new Error('跨站写入被拒绝'), 403)
        const body = await readBody(req)
        const action = asString(body.action, 'load')
        const sessionId = asString(body.sessionId)
        const bound = await scoped(res, sessionId)
        if (bound === undefined) return
        const store = deps.storeFor(bound.cwd)

        if (action === 'load') {
          const payload = body as unknown as LoadWorldBody
          const rel = asString(payload.path).trim()
          if (rel === '') return fail(res, new Error('请给出世界书目录（工作区内的相对路径）'))
          const scanned = await scanWorldbook(bound.cwd, rel, payload.listOnly === true)
          const name = asString(payload.name).trim() || scanned.dirName
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
          if (asBool(payload.bind ?? true, true)) {
            await store.bindRun(sessionId, { worldId: world.id, startedAt: undefined })
          }
          send(res, 200, {
            ok: true,
            world,
            text: scanned.files.map((file) => ({
              rel: file.rel,
              chars: file.chars,
              truncated: file.truncated,
              ...(file.error === undefined ? {} : { error: file.error }),
              ...(file.text === undefined ? {} : { text: file.text }),
            })),
            listOnly: payload.listOnly === true,
          })
          return
        }
        if (action === 'bind') {
          const worldId = asString(body.worldId)
          const world = await store.world(worldId)
          if (world === undefined) return fail(res, new Error(`世界书不存在：${worldId}`), 404)
          const binding = await store.bindRun(sessionId, { worldId })
          send(res, 200, { ok: true, world, binding })
          return
        }
        if (action === 'rename') {
          const worldId = asString(body.worldId)
          const name = asString(body.name).trim()
          if (worldId === '' || name === '') return fail(res, new Error('缺少 worldId 或 name'))
          const world = await store.renameWorld(worldId, name)
          if (world === undefined) return fail(res, new Error(`世界书不存在：${worldId}`), 404)
          send(res, 200, { ok: true, world })
          return
        }
        if (action === 'remove') {
          const worldId = asString(body.worldId)
          const removed = await store.removeWorld(worldId)
          const binding = await store.binding(sessionId)
          if (binding.worldId === worldId) await store.bindRun(sessionId, { worldId: null })
          send(res, 200, { ok: true, removed })
          return
        }
        return fail(res, new Error(`未知 action：${action}`))
      } catch (error) {
        fail(res, error, error instanceof PathFenceError ? 400 : 500)
      }
    },
  })

  // ── world/file：读世界书里的单个文本 ───────────────────────────────────────
  routes.push({
    kind: 'exact',
    path: ROUTES.worldFile,
    handler: async (req, res) => {
      if (!gate(req)) return send(res, 403, { ok: false, error: 'forbidden' })
      try {
        const q = queryOf(req)
        const bound = await scoped(res, asString(q.get('sessionId')))
        if (bound === undefined) return
        const store = deps.storeFor(bound.cwd)
        const world = await store.world(asString(q.get('worldId')))
        if (world === undefined) return fail(res, new Error('世界书不存在'), 404)
        const rel = asString(q.get('rel')).replace(/\\+/g, '/').replace(/^\.\//, '')
        if (rel === '') return fail(res, new Error('缺少 rel'))
        if (rel.split('/').includes('..') || rel.startsWith('/')) {
          return fail(res, new Error('非法 rel（不允许 .. 或绝对路径）'))
        }
        if (!world.files.some((file) => file.rel === rel)) {
          return fail(res, new Error('该文件不属于这本世界书'), 404)
        }
        send(res, 200, { ok: true, ...(await readWorldbookFile(bound.cwd, `${world.path}/${rel}`)) })
      } catch (error) {
        fail(res, error, error instanceof PathFenceError ? 400 : 500)
      }
    },
  })

  // ── rulebook：读一套 / 写一套（同一世界可多套） ─────────────────────────────
  routes.push({
    kind: 'exact',
    path: ROUTES.rulebook,
    handler: async (req, res) => {
      if (!gate(req)) return send(res, 403, { ok: false, error: 'forbidden' })
      try {
        if (req.method === 'GET') {
          const q = queryOf(req)
          const sessionId = asString(q.get('sessionId'))
          const bound = await scoped(res, sessionId)
          if (bound === undefined) return
          const store = deps.storeFor(bound.cwd)
          const worldId = await currentWorldId(store, sessionId, asString(q.get('worldId')))
          if (worldId === undefined) return send(res, 200, { ok: true, rules: [] })
          const rules = await store.rulesOf(worldId)
          const wantId = asString(q.get('rulebookId')) || (await store.binding(sessionId)).rulebookId
          const rule = wantId === undefined ? rules[0] : rules.find((item) => item.id === wantId)
          if (rule === undefined) return send(res, 200, { ok: true, rules, rulebook: null })
          const text = await store.readRulebookMarkdown(rule)
          send(res, 200, {
            ok: true,
            rules,
            rulebook: { ...rule, markdown: text.text, markdownMissing: text.missing },
          })
          return
        }
        if (req.method !== 'POST') return fail(res, new Error('不支持的方法'), 405)
        if (!sameOrigin(req)) return fail(res, new Error('跨站写入被拒绝'), 403)
        const body = (await readBody(req)) as unknown as WriteRulebookBody & { sessionId?: string }
        const sessionId = asString(body.sessionId)
        const bound = await scoped(res, sessionId)
        if (bound === undefined) return
        const store = deps.storeFor(bound.cwd)
        const worldId = await currentWorldId(store, sessionId, asString(body.worldId))
        if (worldId === undefined) return fail(res, new Error('还没有世界书：先在「世界书」页载入一本'), 409)
        const world = await store.world(worldId)
        if (world === undefined) return fail(res, new Error(`世界书不存在：${worldId}`), 404)
        const markdown = asString(body.markdown)
        if (markdown.trim() === '') return fail(res, new Error('规则书内容为空'))
        if (markdown.length > MAX_EDIT_CHARS) return fail(res, new Error('规则书过大（超过 600k 字符）'))
        const style: RuleStyle = RULE_STYLES.some((item) => item.id === body.style) ? (body.style as RuleStyle) : 'custom'
        const title = asString(body.title).trim() || `${world.rulesName ?? world.name}规则书（${ruleStyleInfo(style).id}）`
        const mdRel = await artifactRel(store, asString(body.path), `${title}.md`)
        const rule = await store.writeRulebook({
          worldId,
          ...(asString(body.rulebookId) === '' ? {} : { rulebookId: asString(body.rulebookId) }),
          title,
          style,
          ...(asString(body.pitch) === '' ? {} : { pitch: asString(body.pitch) }),
          mdRel,
          markdown,
          schema: body.schema,
          editedBy: 'user',
        })
        // 换规则书会改变角色卡的属性表：重建会话实例的条目（保留已有取值）。
        const instance = await store.instance(sessionId, worldId, rule)
        await store.saveInstance(instance, 'user')
        if (asBool(body.select ?? true, true)) {
          await store.bindRun(sessionId, { rulebookId: rule.id })
        }
        send(res, 200, { ok: true, rulebook: rule })
      } catch (error) {
        fail(res, error, error instanceof PathFenceError ? 400 : 500)
      }
    },
  })

  // ── module：读 / 写 / 删 / 选 ──────────────────────────────────────────────
  routes.push({
    kind: 'exact',
    path: ROUTES.module,
    handler: async (req, res) => {
      if (!gate(req)) return send(res, 403, { ok: false, error: 'forbidden' })
      try {
        if (req.method === 'GET') {
          const q = queryOf(req)
          const sessionId = asString(q.get('sessionId'))
          const bound = await scoped(res, sessionId)
          if (bound === undefined) return
          const store = deps.storeFor(bound.cwd)
          const worldId = await currentWorldId(store, sessionId, asString(q.get('worldId')))
          if (worldId === undefined) return send(res, 200, { ok: true, modules: [] })
          const modules = await store.modulesOf(worldId)
          const wantId = asString(q.get('moduleId')) || (await store.binding(sessionId)).moduleId
          const one = wantId === undefined ? undefined : modules.find((item) => item.id === wantId)
          if (one === undefined) return send(res, 200, { ok: true, modules })
          const text = await store.readModuleMarkdown(one)
          send(res, 200, {
            ok: true,
            modules,
            module: { ...one, markdown: text.text, markdownMissing: text.missing },
          })
          return
        }
        if (req.method !== 'POST') return fail(res, new Error('不支持的方法'), 405)
        if (!sameOrigin(req)) return fail(res, new Error('跨站写入被拒绝'), 403)
        const body = (await readBody(req)) as unknown as WriteModuleBody & {
          sessionId?: string
          action?: string
        }
        const sessionId = asString(body.sessionId)
        const bound = await scoped(res, sessionId)
        if (bound === undefined) return
        const store = deps.storeFor(bound.cwd)
        const worldId = await currentWorldId(store, sessionId, asString(body.worldId))
        if (worldId === undefined) return fail(res, new Error('还没有世界书：先在「世界书」页载入一本'), 409)

        const action = asString(body.action, 'write')
        if (action === 'select') {
          const moduleId = asString((body as { moduleId?: string }).moduleId)
          const module = await store.module(worldId, moduleId)
          if (module === undefined) return fail(res, new Error(`模组不存在：${moduleId}`), 404)
          const binding = await store.bindRun(sessionId, { moduleId })
          send(res, 200, { ok: true, module, binding })
          return
        }
        if (action === 'remove') {
          const moduleId = asString((body as { moduleId?: string }).moduleId)
          const removed = await store.removeModule(worldId, moduleId)
          const binding = await store.binding(sessionId)
          if (binding.moduleId === moduleId) await store.bindRun(sessionId, { moduleId: null })
          send(res, 200, { ok: true, removed })
          return
        }

        const name = asString(body.name).trim()
        const markdown = asString(body.markdown)
        if (name === '') return fail(res, new Error('模组需要有名字'))
        if (markdown.trim() === '') return fail(res, new Error('模组正文为空'))
        if (markdown.length > MAX_EDIT_CHARS) return fail(res, new Error('模组过大（超过 600k 字符）'))
        const module = await store.writeModule({
          worldId,
          ...(asString(body.moduleId) === '' ? {} : { moduleId: asString(body.moduleId) }),
          name,
          tagline: asString(body.tagline, '（未写钩子）'),
          mdRel: await artifactRel(store, asString((body as { path?: string }).path), `modules/${name}.md`),
          markdown,
          ...(body.scale === undefined ? {} : { scale: body.scale }),
          ...(asString(body.players) === '' ? {} : { players: asString(body.players) }),
          ...(Array.isArray(body.tags) ? { tags: body.tags.map((tag) => String(tag)) } : {}),
          ...(asString(body.rulebookId) === '' ? {} : { rulebookId: asString(body.rulebookId) }),
          source: 'user',
        })
        if (asBool((body as { select?: boolean }).select ?? true, true)) {
          await store.bindRun(sessionId, { moduleId: module.id })
        }
        send(res, 200, { ok: true, module })
      } catch (error) {
        fail(res, error, error instanceof PathFenceError ? 400 : 500)
      }
    },
  })

  // ── pool：角色池（列出 / 删一张） ─────────────────────────────────────────
  routes.push({
    kind: 'exact',
    path: ROUTES.pool,
    handler: async (req, res) => {
      if (!gate(req)) return send(res, 403, { ok: false, error: 'forbidden' })
      try {
        if (req.method === 'GET') {
          const q = queryOf(req)
          const sessionId = asString(q.get('sessionId'))
          const bound = await scoped(res, sessionId)
          if (bound === undefined) return
          const store = deps.storeFor(bound.cwd)
          const worldId = await currentWorldId(store, sessionId, asString(q.get('worldId')))
          send(res, 200, { ok: true, pool: worldId === undefined ? [] : await store.pool(worldId) })
          return
        }
        if (req.method !== 'POST') return fail(res, new Error('不支持的方法'), 405)
        if (!sameOrigin(req)) return fail(res, new Error('跨站写入被拒绝'), 403)
        const body = await readBody(req)
        const sessionId = asString(body.sessionId)
        const bound = await scoped(res, sessionId)
        if (bound === undefined) return
        const store = deps.storeFor(bound.cwd)
        const worldId = await currentWorldId(store, sessionId, asString(body.worldId))
        if (worldId === undefined) return fail(res, new Error('还没有世界书'), 409)
        const action = asString(body.action, 'remove')
        if (action === 'remove') {
          const removed = await store.removeTemplate(worldId, asString(body.templateId))
          send(res, 200, { ok: true, removed, pool: await store.pool(worldId) })
          return
        }
        if (action === 'import') {
          const template = await store.template(worldId, asString(body.templateId))
          if (template === undefined) return fail(res, new Error('角色卡不存在'), 404)
          const binding = await store.binding(sessionId)
          const instance = await store.importTemplate(sessionId, template, {
            ...(binding.rulebookId === undefined ? {} : { rulebookId: binding.rulebookId }),
            ...(binding.moduleId === undefined ? {} : { moduleId: binding.moduleId }),
          })
          await store.bindRun(sessionId, { templateId: template.id })
          send(res, 200, { ok: true, template, character: instance })
          return
        }
        return fail(res, new Error(`未知 action：${action}`))
      } catch (error) {
        fail(res, error, error instanceof PathFenceError ? 400 : 500)
      }
    },
  })

  // ── character：会话中正在扮演的角色卡 ──────────────────────────────────────
  routes.push({
    kind: 'exact',
    path: ROUTES.character,
    handler: async (req, res) => {
      if (!gate(req)) return send(res, 403, { ok: false, error: 'forbidden' })
      try {
        if (req.method === 'GET') {
          const q = queryOf(req)
          const sessionId = asString(q.get('sessionId'))
          const bound = await scoped(res, sessionId)
          if (bound === undefined) return
          const store = deps.storeFor(bound.cwd)
          const worldId = await currentWorldId(store, sessionId, asString(q.get('worldId')))
          if (worldId === undefined) return send(res, 200, { ok: true, character: null })
          const binding = await store.binding(sessionId)
          const rulebook =
            binding.rulebookId === undefined ? undefined : await store.rulebook(worldId, binding.rulebookId)
          send(res, 200, { ok: true, character: await store.instance(sessionId, worldId, rulebook) })
          return
        }
        if (req.method !== 'POST') return fail(res, new Error('不支持的方法'), 405)
        if (!sameOrigin(req)) return fail(res, new Error('跨站写入被拒绝'), 403)
        const body = (await readBody(req)) as unknown as CharacterUpsertBody & { sessionId?: string }
        const sessionId = asString(body.sessionId)
        const bound = await scoped(res, sessionId)
        if (bound === undefined) return
        const store = deps.storeFor(bound.cwd)
        const worldId = await currentWorldId(store, sessionId, asString(body.worldId))
        if (worldId === undefined) return fail(res, new Error('还没有世界书'), 409)
        const binding = await store.binding(sessionId)
        const rulebook =
          binding.rulebookId === undefined ? undefined : await store.rulebook(worldId, binding.rulebookId)

        /**
         * 只带上"请求里确实提供了"的字段。
         * 旧实现把缺失字段一律当空值（`name → ''`、数组 → `[]`），再整体覆盖已有角色卡，
         * 于是任何**部分请求**都会静默清空姓名/属性/物品/经历；反过来 notes 之类
         * 又是"空即省略"，永远清不掉——同一个函数里两种相反语义。
         */
        const provided = (): Partial<CharacterBody> => {
          const out: Partial<CharacterBody> = {}
          const has = (key: string): boolean => Object.prototype.hasOwnProperty.call(body, key)
          const record = body as Record<string, unknown>
          if (has('name')) out.name = asString(body.name)
          if (has('concept')) out.concept = asString(body.concept)
          if (has('player')) out.player = asString(body.player)
          if (has('notes')) out.notes = asString(body.notes)
          if (has('initialized')) out.initialized = body.initialized === true
          for (const key of ['attrs', 'skills', 'slots', 'statuses', 'journal'] as const) {
            const value = record[key]
            if (Array.isArray(value)) (out as Record<string, unknown>)[key] = value
          }
          return out
        }

        // 写角色池
        if (body.pool === true) {
          const template = await store.saveTemplate(
            {
              worldId,
              ...(asString(body.id) === '' ? {} : { templateId: asString(body.id) }),
              body: { ...emptyCharacterBody(), ...provided() },
              ...(asString(body.rulebookId) === '' ? {} : { rulebookId: asString(body.rulebookId) }),
              ...(asString(body.moduleId) === '' ? {} : { moduleId: asString(body.moduleId) }),
              generated: body.generated === true,
              source: 'user',
            },
            rulebook,
          )
          send(res, 200, { ok: true, template, pool: await store.pool(worldId) })
          return
        }

        // 写会话实例（默认路径）
        const instance = await store.instance(sessionId, worldId, rulebook)
        const merged = { ...instance, ...provided() }
        const saved = await store.saveInstance(merged, 'user')
        send(res, 200, { ok: true, character: saved })
      } catch (error) {
        fail(res, error, error instanceof PathFenceError ? 400 : 500)
      }
    },
  })

  // ── run：读 / 设四元组 ────────────────────────────────────────────────────
  routes.push({
    kind: 'exact',
    path: ROUTES.run,
    handler: async (req, res) => {
      if (!gate(req)) return send(res, 403, { ok: false, error: 'forbidden' })
      try {
        const q = queryOf(req)
        if (req.method === 'GET') {
          const sessionId = asString(q.get('sessionId'))
          const bound = await scoped(res, sessionId)
          if (bound === undefined) return
          const store = deps.storeFor(bound.cwd)
          const { run, binding } = await buildRun(store, sessionId)
          send(res, 200, { ok: true, run, binding })
          return
        }
        if (req.method !== 'POST') return fail(res, new Error('不支持的方法'), 405)
        if (!sameOrigin(req)) return fail(res, new Error('跨站写入被拒绝'), 403)
        const body = (await readBody(req)) as unknown as BindRunBody & { sessionId?: string }
        const sessionId = asString(body.sessionId)
        const bound = await scoped(res, sessionId)
        if (bound === undefined) return
        const store = deps.storeFor(bound.cwd)
        const patch: Parameters<ScorpioStore['bindRun']>[1] = {}
        if (body.worldId !== undefined) patch.worldId = asString(body.worldId) || null
        if (body.rulebookId !== undefined) patch.rulebookId = asString(body.rulebookId) || null
        if (body.moduleId !== undefined) patch.moduleId = asString(body.moduleId) || null
        if (body.templateId !== undefined) patch.templateId = asString(body.templateId) || null
        await store.bindRun(sessionId, patch)
        // 选了角色池里的某一张 → 导入为会话实例。
        if (body.templateId !== undefined && asString(body.templateId) !== '') {
          const binding = await store.binding(sessionId)
          if (binding.worldId !== undefined) {
            const template = await store.template(binding.worldId, asString(body.templateId))
            if (template !== undefined) {
              await store.importTemplate(sessionId, template, {
                ...(binding.rulebookId === undefined ? {} : { rulebookId: binding.rulebookId }),
                ...(binding.moduleId === undefined ? {} : { moduleId: binding.moduleId }),
              })
            }
          }
        }
        const { run, binding } = await buildRun(store, sessionId)
        send(res, 200, { ok: true, run, binding })
      } catch (error) {
        fail(res, error, error instanceof PathFenceError ? 400 : 500)
      }
    },
  })

  // ── dice：判定流水（侧边栏）+ 悬浮卡掷骰 ────────────────────────────────────
  routes.push({
    kind: 'exact',
    path: ROUTES.dice,
    handler: async (req, res) => {
      if (!gate(req)) return send(res, 403, { ok: false, error: 'forbidden' })
      try {
        const q = queryOf(req)
        if (req.method === 'GET') {
          const sessionId = asString(q.get('sessionId'))
          const bound = await scoped(res, sessionId)
          if (bound === undefined) return
          const store = deps.storeFor(bound.cwd)
          const rawLimit = Number(q.get('limit') ?? 60)
          send(res, 200, { ok: true, dice: await store.diceLedger(Number.isFinite(rawLimit) ? rawLimit : 60) })
          return
        }
        if (req.method !== 'POST') return fail(res, new Error('不支持的方法'), 405)
        if (!sameOrigin(req)) return fail(res, new Error('跨站写入被拒绝'), 403)
        const body = await readBody(req)
        const sessionId = asString(body.sessionId)
        const bound = await scoped(res, sessionId)
        if (bound === undefined) return
        const store = deps.storeFor(bound.cwd)
        const binding = await store.binding(sessionId)
        const rulebook =
          binding.worldId !== undefined && binding.rulebookId !== undefined
            ? await store.rulebook(binding.worldId, binding.rulebookId)
            : undefined
        const sheet =
          binding.worldId === undefined
            ? undefined
            : await store.instance(sessionId, binding.worldId, rulebook)
        const request = { ...((body.request ?? {}) as RollRequest) }
        // 形状校验：`opposed: null` 会在对抗分支抛 TypeError（500）；NaN 会被当成"没给"。
        if (request.opposed === null || typeof request.opposed !== 'object') delete request.opposed
        if (!Number.isFinite(request.difficulty ?? 0)) delete request.difficulty
        if (!Number.isFinite(request.modifier ?? 0)) delete request.modifier
        const result: RollResult = performRoll(
          { ...request, actor: request.actor ?? 'user' },
          { schema: rulebook?.schema, sheet },
        )
        await store.appendRoll(result)
        send(res, 200, { ok: true, result })
      } catch (error) {
        fail(res, error, error instanceof PathFenceError ? 400 : 500)
      }
    },
  })

  const register = (server: PluginWebServer): (() => void) => {
    const disposers: Array<() => void> = []
    for (const route of routes) {
      try {
        disposers.push(server.register(route))
      } catch (error) {
        log('route register failed:', route.path, String(error))
      }
    }
    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* 已释放 */
        }
      }
    }
  }

  return { routes, register }
}

