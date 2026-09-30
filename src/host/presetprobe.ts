/**
 * 临时探针：`node src/host/presetprobe.ts`
 *
 * 验证 `resolveSessionPreset` / `resolveSessionCwd` 在三种会话来源下的行为：
 *   · 内存态 live 会话（零 IO，不碰 sessionQuery）
 *   · 冷会话走 observeSession（seeded 会话安全）
 *   · 老宿主只有 readSession（兜底，且被 seeded 报错时不炸）
 */
import { resolveSessionCwd, resolveSessionPreset } from './worldbook.ts'
import type { PluginContext } from './context.ts'

let passed = 0
let failed = 0
const ok = (condition: boolean, label: string, detail?: unknown): void => {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${label}`)
  } else {
    failed += 1
    console.log(`  ✗ ${label}${detail === undefined ? '' : `  → ${JSON.stringify(detail)}`}`)
  }
}

const calls: string[] = []
const seededError = 'seeded session constructor seed must equal its inherited prefix'

const presetEvents = [
  { type: 'agent-preset/selected', data: { agentPreset: 'cordis' } },
  { type: 'turn/start' },
  { type: 'agent-preset/selected', data: { agentPreset: 'scorpio' } },
]

/** live：sessions.get 命中。 */
const liveCtx = {
  get(name: string) {
    if (name === 'sessions') {
      return {
        get: (id: string) =>
          id === 'live' ? { id, header: { id, cwd: '/tmp/live', agentPreset: 'standard' }, snapshotEvents: () => presetEvents } : undefined,
        list: () => [],
      }
    }
    if (name === 'sessionQuery') {
      return {
        readSession: async () => {
          calls.push('live:readSession')
          throw new Error(seededError)
        },
        observeSession: async () => {
          calls.push('live:observeSession')
          return { header: { id: 'live', cwd: '/tmp/obs' } }
        },
      }
    }
    return undefined
  },
  effect() {},
} as unknown as PluginContext

/** 冷会话：只有 observeSession 可用（readSession 会抛 seeded 错误）。 */
const coldCtx = {
  get(name: string) {
    if (name === 'sessions') return { get: () => undefined, list: () => [] }
    if (name === 'sessionQuery') {
      return {
        readSession: async () => {
          calls.push('cold:readSession')
          throw new Error(seededError)
        },
        observeSession: async () => {
          calls.push('cold:observeSession')
          return { header: { id: 'cold', cwd: '/tmp/cold' }, inheritedEventCount: 1813, events: presetEvents }
        },
      }
    }
    return undefined
  },
  effect() {},
} as unknown as PluginContext

/** 老宿主：只有 readSession，且对 seeded 会话必然抛错。 */
const legacyCtx = {
  get(name: string) {
    if (name === 'sessions') return { get: () => undefined, list: () => [] }
    if (name === 'sessionQuery') {
      return {
        readSession: async () => {
          calls.push('legacy:readSession')
          throw new Error(seededError)
        },
      }
    }
    return undefined
  },
  effect() {},
} as unknown as PluginContext

/** 老宿主 + 未 seeded 会话：readSession 正常，兜底可用。 */
const legacyOkCtx = {
  get(name: string) {
    if (name === 'sessions') return { get: () => undefined, list: () => [] }
    if (name === 'sessionQuery') {
      return {
        readSession: async () => {
          calls.push('legacyOk:readSession')
          return { session: { id: 'ok', cwd: '/tmp/ok', agentPreset: 'standard' }, events: presetEvents }
        },
      }
    }
    return undefined
  },
  effect() {},
} as unknown as PluginContext

console.log('── live 会话（内存态优先）──')
{
  const info = await resolveSessionPreset(liveCtx, 'live')
  ok(info.preset === 'scorpio', 'live：取最新 agent-preset/selected', info)
  ok(info.cwd === '/tmp/live', 'live：cwd 来自内存头', info)
  ok(!calls.includes('live:readSession'), 'live：不调用 readSession')
  ok(!calls.includes('live:observeSession'), 'live：不调用 observeSession')
}

console.log('\n── 冷会话（observeSession）──')
{
  calls.length = 0
  const info = await resolveSessionPreset(coldCtx, 'cold')
  ok(info.preset === 'scorpio', 'cold：取最新 agent-preset/selected', info)
  ok(info.cwd === '/tmp/cold', 'cold：cwd 来自观察租约', info)
  ok(calls.includes('cold:observeSession'), 'cold：走 observeSession')
  ok(!calls.includes('cold:readSession'), 'cold：不调用会抛错的 readSession')

  const cwd = await resolveSessionCwd(coldCtx, 'cold')
  ok(cwd === '/tmp/cold', 'cold：resolveSessionCwd 同样可用', { cwd })
}

console.log('\n── 老宿主（只有 readSession，seeded 报错）──')
{
  calls.length = 0
  const info = await resolveSessionPreset(legacyCtx, 'legacy')
  ok(info.preset === undefined && info.cwd === undefined, 'legacy：不抛异常，返回空结论', info)
  ok(calls.includes('legacy:readSession'), 'legacy：确实尝试过兜底')
}

console.log('\n── 老宿主 + 未 seeded 会话 ──')
{
  calls.length = 0
  const info = await resolveSessionPreset(legacyOkCtx, 'ok')
  ok(info.preset === 'scorpio', 'legacyOk：兜底仍能取到预设', info)
  ok(info.cwd === '/tmp/ok', 'legacyOk：兜底 cwd 正常', info)
}

console.log(`\n通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) process.exit(1)
