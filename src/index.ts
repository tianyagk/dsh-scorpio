/**
 * dsh-scorpio — 宿主半区入口。
 *
 * 一个「双面」bundle 行（id: scorpio / name: dsh-scorpio）：
 *  - node 半区（本文件）：世界书扫描 / 规则书与角色卡存储 / 判定引擎 /
 *    `/scorpio/*` 路由 / 模型工具 / 天蝎座主持提示词；
 *  - 浏览器半区（src/client）：通过 ctx.betterSidebar 注册「天蝎座」页签，
 *    只在 Scorpio 预设的会话里渲染完整配置窗。
 *
 * 宿主半区是进程级挂载的，**不区分预设**：它服务所有会话，转而在每次请求里
 * 用 sessionQuery 判定「这个会话是不是 Scorpio」，非 Scorpio 一律 403。
 * 模型工具只在工具体内做同一道判断，因此不会被别的预设误用。
 */
import { makeScorpioRoutes } from './host/routes.ts'
import { makeAgentTools } from './host/tools.ts'
import { ScorpioStore } from './host/store.ts'
import { log, type PluginContext } from './host/context.ts'

/** bundle-patch 行的插件标识。 */
export const name = 'dsh-scorpio'
export const version = '0.2.0'

/** 挂载前必须就绪的服务：webserver 路由。 */
export const inject = ['webServer']

export function apply(ctx: PluginContext): void {
  // store 按工作区（会话 cwd）缓存：同一工作区共享索引/绑定/规则书/角色卡。
  const stores = new Map<string, ScorpioStore>()
  const storeFor = (workspace: string): ScorpioStore => {
    let store = stores.get(workspace)
    if (store === undefined) {
      store = new ScorpioStore(workspace)
      stores.set(workspace, store)
      if (stores.size > 64) {
        const oldest = stores.keys().next().value
        if (typeof oldest === 'string') stores.delete(oldest)
      }
    }
    return store
  }

  ctx.effect(() => {
    const server = ctx.webServer ?? ctx.get('webServer')
    if (server === undefined) {
      log('webServer 服务缺失 —— /scorpio/* 路由未注册（模型工具仍会尝试注册）')
      return
    }
    const { register } = makeScorpioRoutes({ ctx, storeFor })
    const dispose = register(server)
    log('routes registered: /scorpio/{health,whoami,snapshot,worldbook,rulebook,character,dice}')
    return dispose
  }, 'dsh-scorpio: routes')

  ctx.effect(() => {
    const tools = ctx.get('tools')
    if (tools === undefined) {
      log('tools 服务缺失 —— 模型工具未注册（UI 路由仍然可用）')
      return
    }
    const prompt = ctx.get('systemPrompt')
    const { registerTools } = makeAgentTools({ ctx, storeFor })
    return registerTools(tools, prompt)
  }, 'dsh-scorpio: agent tools')
}
