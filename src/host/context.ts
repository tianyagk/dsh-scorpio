/**
 * dsh-scorpio — 宿主半区消费的 DSH 服务「结构面」。
 *
 * 本插件在 DSH monorepo 之外解析，上游的 `declare module '@deepseek-ai/cordis'`
 * 增强不一定能到达这里的 Context，所以下面用结构化接口镜像真实运行时的形状
 * （与 dsh-tradewatcher / dsh-better-sidebar 的做法一致）。loader 传入的真实 ctx
 * 在结构上满足这些接口；所有可选能力一律用 `ctx.get(name)` 读取并判空。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

/** `ctx.webRuntime.trustedHosts` —— /api 网关的信任来源。 */
export interface PluginWebRuntime {
  trustedHosts: readonly string[]
}

/** 一条具名 webserver 路由（镜像 @deepseek-ai/dsh-host-webserver 的 WebRoute）。 */
export interface PluginWebRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

export interface PluginWebServer {
  register(route: PluginWebRoute): () => void
}

/** 模型工具定义的结构面（host 只读这些字段，普通对象字面量即可满足）。 */
export interface PluginToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render(args: unknown, value: unknown): Array<{ type: 'text'; text: string }>
  }
  execute(args: Record<string, unknown>, exec?: { signal?: AbortSignal }): Promise<unknown>
}

export interface PluginToolRuntime {
  register(def: PluginToolDefinition): () => void
}

/** 一段系统提示词（返回 disposer）。 */
export interface PluginSystemPrompt {
  section(opts: { name: string; order: number; text: () => string }): () => void
}

/** 会话头里我们关心的字段（`SessionHeader` 的结构子集）。 */
export interface SessionHeaderFace {
  id: string
  cwd?: string
  agentPreset?: string
}

/** 会话事件里我们关心的字段。 */
export interface PluginSessionEvent {
  type?: string
  data?: { agentPreset?: string }
}

/** `ctx.sessionQuery.observeSession()` 的观察租约（结构子集）。 */
export interface PluginSessionObservation {
  header: SessionHeaderFace
  inheritedEventCount?: number
  events?: PluginSessionEvent[]
}

/** `ctx.sessionQuery.readSession()` 的结构面。 */
export interface PluginSessionQuery {
  readSession(sessionId: string): Promise<{
    session: SessionHeaderFace
    events: PluginSessionEvent[]
  }>
  /**
   * 观察租约：宿主内部用 detached restore 重建会话，seeded 会话同样安全。
   * 新版宿主才提供，故为可选能力，用前判空。
   */
  observeSession?(
    sessionId: string,
    options?: { projectionMode?: 'none' | 'all' },
  ): Promise<PluginSessionObservation>
}

/** `ctx.sessions` 的结构面（内存态会话，首选来源）。 */
export interface PluginSessionFace {
  id?: string
  header?: SessionHeaderFace
  /** 完整日志的只读快照（`Session.snapshotEvents`）。 */
  snapshotEvents?(fromSeq?: number, toSeqExclusive?: number): PluginSessionEvent[]
}

export interface PluginSessions {
  get(id: string): PluginSessionFace | undefined
  list(): PluginSessionFace[]
}

/** `ctx.agentPresets` 的结构面（只读用）。 */
export interface PluginAgentPresets {
  list(): Promise<Array<{ id: string; path: string; trust?: string; broken?: string }>>
  defaultId?: string
}

export interface PluginContext {
  webServer?: PluginWebServer
  webRuntime?: PluginWebRuntime
  effect(fn: () => void | (() => void), label?: string): void
  get(name: 'tools'): PluginToolRuntime | undefined
  get(name: 'systemPrompt'): PluginSystemPrompt | undefined
  get(name: 'sessionQuery'): PluginSessionQuery | undefined
  get(name: 'sessions'): PluginSessions | undefined
  get(name: 'agentPresets'): PluginAgentPresets | undefined
  get(name: 'webServer'): PluginWebServer | undefined
  get(name: 'webRuntime'): PluginWebRuntime | undefined
  get(name: string): unknown
}

/** 统一日志前缀。 */
export function log(...parts: unknown[]): void {
  console.log('[scorpio]', ...parts)
}
