/**
 * 路由层自测：`node src/host/routetest.ts`
 *
 * 这是 v0.2 里**唯一**覆盖 `/scorpio/*` 的测试——934 行路由是界面的唯一数据通道，
 * 也是本次评审发现的多条数据风险（产物路径越界、部分写入清空角色卡、请求形状）
 * 的所在地。用假 ctx 直接驱动真实的路由处理器，不需要起 dsh 进程。
 *
 * 覆盖重点：
 *   · 预设闸门（非天蝎座会话一律 403）
 *   · 产物落盘的职责边界（拒 `.scorpio/`、拒世界书目录、拒非 .md、拒 `..`）
 *   · 角色卡写入的「未提供 ≠ 显式置空」
 *   · `/scorpio/world/file` 的白名单
 *   · 掷骰请求形状与 limit 参数兜底
 *   · 四元组的读/设，以及齐备后仍可掷骰
 */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { ROUTES } from '../shared/model.ts'
import { makeScorpioRoutes } from './routes.ts'
import { ScorpioStore } from './store.ts'
import type { PluginContext } from './context.ts'

let passed = 0
let failed = 0
const failures: string[] = []

function ok(condition: boolean, label: string, detail?: unknown): void {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${label}`)
  } else {
    failed += 1
    failures.push(label)
    console.log(`  ✗ ${label}${detail === undefined ? '' : `  → ${JSON.stringify(detail)}`}`)
  }
}

const eq = (actual: unknown, expected: unknown, label: string): void =>
  ok(actual === expected, label, { actual, expected })

const section = (title: string): void => console.log(`\n── ${title} ──`)

// ── 假 ctx：只实现路由用到的几项 ────────────────────────────────────────────

interface SessionStub {
  id: string
  cwd: string
  preset: string
}

function makeCtx(sessions: SessionStub[]): PluginContext {
  const byId = new Map(sessions.map((session) => [session.id, session]))
  return {
    effect: () => undefined,
    get: (name: string): unknown => {
      if (name === 'webRuntime') return { trustedHosts: [] }
      if (name === 'agentPresets') {
        return {
          list: async () => [
            { id: 'standard', path: '/presets/standard/agent.cordis.yml' },
            { id: 'scorpio', path: '/presets/scorpio/agent.cordis.yml' },
          ],
        }
      }
      if (name === 'sessions') {
        return {
          get: (id: string) => {
            const session = byId.get(id)
            if (session === undefined) return undefined
            return {
              id: session.id,
              header: { id: session.id, cwd: session.cwd, agentPreset: session.preset },
              snapshotEvents: () => [{ type: 'agent-preset/selected', data: { agentPreset: session.preset } }],
            }
          },
          list: () => [...byId.values()].map((session) => ({ id: session.id })),
        }
      }
      return undefined
    },
  } as unknown as PluginContext
}

// ── HTTP 桩 ─────────────────────────────────────────────────────────────────

interface Reply {
  status: number
  body: Record<string, unknown>
}

type Routes = ReturnType<typeof makeScorpioRoutes>['routes']

async function call(
  routes: Routes,
  method: 'GET' | 'POST',
  path: string,
  init: { query?: Record<string, string>; body?: unknown; origin?: string } = {},
): Promise<Reply> {
  const route = routes.find((item) => item.path === path)
  if (route === undefined) throw new Error(`route not found: ${path}`)
  const search = new URLSearchParams(init.query ?? {}).toString()
  const url = search === '' ? path : `${path}?${search}`
  let status = 200
  let payload = ''
  const headers: Record<string, string> = { host: '127.0.0.1:3080' }
  if (method === 'POST') headers.origin = init.origin ?? 'http://127.0.0.1:3080'
  const req = {
    method,
    url,
    headers,
    async *[Symbol.asyncIterator]() {
      if (init.body !== undefined) yield Buffer.from(JSON.stringify(init.body), 'utf8')
    },
  } as unknown as IncomingMessage
  const res = {
    writeHead(code: number) {
      status = code
      return this
    },
    end(chunk?: string) {
      payload = chunk ?? ''
    },
  } as unknown as ServerResponse
  await route.handler(req, res)
  return { status, body: payload === '' ? {} : (JSON.parse(payload) as Record<string, unknown>) }
}

// ── 临时工作区 ──────────────────────────────────────────────────────────────

const root = await mkdtemp(join(tmpdir(), 'scorpio-routes-'))
const ws = join(root, 'ws')
await mkdir(join(ws, 'corpus'), { recursive: true })
await writeFile(join(ws, 'corpus', '密教世界书.md'), '# 密教\n\n1926 年伦敦。\n', 'utf8')

const scorpioSession = 'session-scorpio'
const otherSession = 'session-standard'
const ctx = makeCtx([
  { id: scorpioSession, cwd: ws, preset: 'scorpio' },
  { id: otherSession, cwd: ws, preset: 'standard' },
])
const { routes } = makeScorpioRoutes({ ctx, storeFor: (workspace: string) => new ScorpioStore(workspace) })
const S = scorpioSession

// ── 预设闸门 ────────────────────────────────────────────────────────────────
section('预设闸门')

const health = await call(routes, 'GET', ROUTES.health)
eq(health.status, 200, 'health 放行')
eq(health.body.preset, 'scorpio', 'health 报告预设 id')

const whoScorpio = await call(routes, 'GET', ROUTES.whoami, { query: { sessionId: S } })
eq(whoScorpio.status, 200, 'Scorpio 会话 whoami 200')
eq(whoScorpio.body.scorpio, true, 'whoami: scorpio=true')
eq(whoScorpio.body.cwd, ws, 'whoami 回传工作区')

const whoOther = await call(routes, 'GET', ROUTES.whoami, { query: { sessionId: otherSession } })
eq(whoOther.body.scorpio, false, '标准模式会话 whoami: scorpio=false')

const whoGhost = await call(routes, 'GET', ROUTES.whoami, { query: { sessionId: 'session-ghost' } })
eq(whoGhost.status, 200, '未知会话 whoami 仍作答（页签提示通道）')
eq(whoGhost.body.scorpio, false, '未知会话 scorpio=false')

const snapOther = await call(routes, 'GET', ROUTES.snapshot, { query: { sessionId: otherSession } })
eq(snapOther.status, 403, '标准模式会话 snapshot 403')
const worldOther = await call(routes, 'POST', ROUTES.world, { body: { action: 'load', sessionId: otherSession, path: 'corpus' } })
eq(worldOther.status, 403, '标准模式会话写世界书 403')
const ghostSnap = await call(routes, 'GET', ROUTES.snapshot, { query: { sessionId: 'session-ghost' } })
eq(ghostSnap.status, 403, '未知会话 snapshot 403')

// ── 世界书 ──────────────────────────────────────────────────────────────────
section('世界书')

const load = await call(routes, 'POST', ROUTES.world, {
  body: { action: 'load', sessionId: S, path: 'corpus', name: '密教模拟器' },
})
eq(load.status, 200, '载入世界书 200')
const worldId = String((load.body.world as { id?: string } | undefined)?.id ?? '')
eq(worldId, '密教模拟器', '世界书 id 由展示名 slug 化')
const text = load.body.text as Array<{ rel: string; text?: string }> | undefined
ok((text ?? []).some((file) => file.text?.includes('伦敦')), '载入回传全文')

const snap = await call(routes, 'GET', ROUTES.snapshot, { query: { sessionId: S } })
eq(snap.status, 200, 'snapshot 200')
const run = snap.body.run as { missing?: string[]; ready?: boolean } | undefined
eq((run?.missing ?? []).join(','), 'rulebook,module,character', '四元组缺项：规则书/模组/角色卡')
eq(run?.ready, false, '四元组未齐备')

// ── 产物落盘的职责边界 ──────────────────────────────────────────────────────
section('产物落盘的职责边界')

const schema = {
  system: '密教 d100', baseDice: '1d100', direction: 'rollUnder', defaultDifficulty: 0,
  attributes: [{ id: 'reason', label: '理智' }], skills: [{ id: 'study', label: '研习', attribute: 'reason' }],
}
const writeRulebook = (path: string): Promise<Reply> =>
  call(routes, 'POST', ROUTES.rulebook, {
    body: { sessionId: S, worldId, style: 'd100', title: '密教模拟器规则书', markdown: '# 规则\n', schema, path },
  })

const intoState = await writeRulebook('.scorpio/session.json')
eq(intoState.status, 400, '规则书不能写入 .scorpio/（否则会覆盖会话绑定）')
const intoWorldbook = await writeRulebook('corpus/密教世界书.md')
eq(intoWorldbook.status, 400, '规则书不能写入世界书目录（那是玩家的源资料）')
const notMd = await writeRulebook('notes.txt')
eq(notMd.status, 400, '产物必须是 .md')
const escape = await writeRulebook('../escape.md')
eq(escape.status, 400, '产物路径不能逃出工作区')
const good = await writeRulebook('rules/密教模拟器规则书.md')
eq(good.status, 200, '正常路径写入成功')
eq((good.body.rulebook as { style?: string } | undefined)?.style, 'd100', '规则书风格落盘')

const snap2 = await call(routes, 'GET', ROUTES.snapshot, { query: { sessionId: S } })
const run2 = snap2.body.run as { missing?: string[] } | undefined
eq((run2?.missing ?? []).join(','), 'module,character', '写入规则书后缺项收敛')

// ── 角色卡：未提供 ≠ 显式置空 ───────────────────────────────────────────────
section('角色卡写入语义')

const full = await call(routes, 'POST', ROUTES.character, {
  body: {
    sessionId: S,
    name: '林奕',
    concept: '记者',
    notes: '初始备注',
    attrs: [{ id: 'reason', value: 60 }],
    skills: [{ id: 'study', value: 20 }],
    slots: [{ id: 'i1', name: '黄铜书签', kind: 'item' }],
    initialized: false,
  },
})
eq(full.status, 200, '整卡写入 200')
const fullBody = full.body.character as { name?: string; attrs?: unknown[]; notes?: string } | undefined
eq(fullBody?.name, '林奕', '姓名落盘')
eq(fullBody?.attrs?.length, 1, '属性落盘')

const partial = await call(routes, 'POST', ROUTES.character, { body: { sessionId: S, notes: '只改备注' } })
eq(partial.status, 200, '部分字段写入 200')
const partialBody = partial.body.character as { name?: string; attrs?: unknown[]; slots?: unknown[]; notes?: string } | undefined
eq(partialBody?.notes, '只改备注', '备注被更新')
eq(partialBody?.name, '林奕', '★ 部分写入不清空姓名（旧实现会清成空串）')
eq(partialBody?.attrs?.length, 1, '★ 部分写入不清空属性（旧实现会清成 []）')
eq(partialBody?.slots?.length, 1, '★ 部分写入不清空物品')

const clearNotes = await call(routes, 'POST', ROUTES.character, { body: { sessionId: S, notes: '' } })
eq((clearNotes.body.character as { notes?: string } | undefined)?.notes, '', '★ 显式传空串能清掉备注（旧实现永远清不掉）')

// 角色池：存一张 + 导入
const pooled = await call(routes, 'POST', ROUTES.character, {
  body: { sessionId: S, pool: true, name: '备选角色', attrs: [{ id: 'reason', value: 50 }], initialized: true },
})
eq(pooled.status, 200, '写入角色池 200')
const imported = await call(routes, 'POST', ROUTES.pool, {
  body: { sessionId: S, action: 'import', templateId: '备选角色' },
})
eq(imported.status, 200, '从角色池导入 200')
eq((imported.body.character as { templateId?: string } | undefined)?.templateId, '备选角色', '导入后实例记住模板 id')

// ── 模组 ────────────────────────────────────────────────────────────────────
section('模组集')

const badModuleName = await call(routes, 'POST', ROUTES.module, {
  body: { sessionId: S, action: 'write', name: '../../corpus/密教世界书', tagline: 'x', markdown: '# 模组\n' },
})
eq(badModuleName.status, 400, '★ 模组名不能借 ../ 覆盖世界书源文件')
const moduleWrite = await call(routes, 'POST', ROUTES.module, {
  body: { sessionId: S, action: 'write', name: '一封来自死者的信', tagline: '顾知白的遗信', markdown: '# 开场\n\n雾。\n', scale: 'one-shot' },
})
eq(moduleWrite.status, 200, '写模组 200')
const moduleSelect = await call(routes, 'POST', ROUTES.module, { body: { sessionId: S, action: 'select', moduleId: '一封来自死者的信' } })
eq(moduleSelect.status, 200, '选定模组 200')

// ── 世界书内文件读取白名单 ──────────────────────────────────────────────────
section('world/file 白名单')

const traversal = await call(routes, 'GET', ROUTES.worldFile, { query: { sessionId: S, worldId, rel: '../.scorpio/session.json' } })
eq(traversal.status, 400, '★ 不允许 ../ 读状态文件')
const notListed = await call(routes, 'GET', ROUTES.worldFile, { query: { sessionId: S, worldId, rel: '不存在.md' } })
eq(notListed.status, 404, '不在世界书清单里的文件 404')
const listed = await call(routes, 'GET', ROUTES.worldFile, { query: { sessionId: S, worldId, rel: '密教世界书.md' } })
eq(listed.status, 200, '清单内的文件可读')
ok(String(listed.body.text ?? '').includes('伦敦'), '读回正文')

// ── 判定 ────────────────────────────────────────────────────────────────────
section('判定与流水')

const roll = await call(routes, 'POST', ROUTES.dice, {
  body: { sessionId: S, request: { check: 'study', action: '在黑暗中摸索' } },
})
eq(roll.status, 200, '掷骰 200')
const result = roll.body.result as { verdict?: string; roll?: { target?: number } } | undefined
ok(typeof result?.verdict === 'string' && result.verdict !== '', '判定给出可引用结论')

const nullOpposed = await call(routes, 'POST', ROUTES.dice, {
  body: { sessionId: S, request: { expression: '1d100', opposed: null, difficulty: 'abc', modifier: null } },
})
eq(nullOpposed.status, 200, '★ opposed:null / NaN 输入不再 500')

const nanLimit = await call(routes, 'GET', ROUTES.dice, { query: { sessionId: S, limit: 'abc' } })
eq(nanLimit.status, 200, '★ limit=abc 不报错')
const ledger = nanLimit.body.dice as { total?: number } | undefined
eq(ledger?.total, 2, '★ limit=abc 回落到默认条数（此前 NaN 会返回空列表）')

// ── 四元组齐备 ──────────────────────────────────────────────────────────────
section('四元组')

const ready = await call(routes, 'POST', ROUTES.run, { body: { sessionId: S, templateId: '备选角色' } })
eq(ready.status, 200, '设置角色卡 200')
const readyRun = ready.body.run as { ready?: boolean; missing?: string[] } | undefined
eq((readyRun?.missing ?? []).join(','), '', '四元组不再缺项')
eq(readyRun?.ready, true, '四元组齐备（可开演）')

const cleared = await call(routes, 'POST', ROUTES.run, { body: { sessionId: S, rulebookId: '' } })
eq((cleared.body.run as { missing?: string[] } | undefined)?.missing?.includes('rulebook'), true, '清空规则书后缺项回归')

// ── 收尾 ────────────────────────────────────────────────────────────────────
await rm(root, { recursive: true, force: true })
console.log(`\n${failed === 0 ? '✅' : '❌'} 路由自测：通过 ${passed} 项 / 失败 ${failed} 项`)
if (failed > 0) {
  for (const item of failures) console.log(`  · ${item}`)
  process.exitCode = 1
}
