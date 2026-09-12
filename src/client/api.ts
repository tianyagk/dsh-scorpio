/**
 * 浏览器半区与宿主半区之间的同源 JSON 通道。
 *
 * 所有请求都带 `sessionId`：宿主用它解析会话 cwd（工作区）并判定预设。
 * 任何非 2xx 都在这里变成可读错误，UI 只负责显示。
 */
import {
  ROUTES,
  type CharacterInstance,
  type CharacterTemplate,
  type Module,
  type RollRequest,
  type RollResult,
  type RuleStyle,
  type Rulebook,
  type RulesSchema,
  type RunReport,
  type RunBinding,
  type World,
} from '../shared/model.ts'

interface ApiError {
  ok: false
  error: string
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      accept: 'application/json',
      ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(init?.headers ?? {}),
    },
  })
  const body = await response.text()
  let payload: unknown
  if (body !== '') {
    try {
      payload = JSON.parse(body)
    } catch {
      throw new Error(`响应不是 JSON（HTTP ${response.status}）`)
    }
  }
  if (!response.ok) {
    const message =
      payload !== null && typeof payload === 'object' && typeof (payload as ApiError).error === 'string'
        ? (payload as ApiError).error
        : `HTTP ${response.status}`
    throw new Error(message)
  }
  return payload as T
}

const qs = (params: Record<string, string | number | undefined>): string => {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue
    search.set(key, String(value))
  }
  const text = search.toString()
  return text === '' ? '' : `?${text}`
}

const post = <T>(path: string, body: Record<string, unknown>): Promise<T> =>
  request<T>(path, { method: 'POST', body: JSON.stringify(body) })

export interface WhoAmIResponse {
  ok: true
  sessionId: string
  preset?: string
  scorpio: boolean
  cwd?: string
  unresolvable?: string
  pluginVersion: string
}

export interface WorldView extends World {
  rules: Rulebook[]
  modules: Array<Pick<Module, 'id' | 'name' | 'tagline' | 'scale' | 'updatedAt'>>
  characterCount: number
}

export interface SnapshotResponse {
  ok: true
  who: WhoAmIResponse & { stateDir?: string }
  worlds: WorldView[]
  binding: RunBinding
  run: RunReport
  character?: CharacterInstance
  rulebook?: Rulebook & { markdown?: string; markdownMissing?: boolean }
  module?: Module & { markdown?: string; markdownMissing?: boolean }
  pool: CharacterTemplate[]
  modules: Module[]
  dice: { total: number; recent: RollResult[] }
  presetIds?: string[]
  serverTime: number
}

export interface LoadWorldResult {
  ok: true
  world: World
  text: Array<{ rel: string; chars: number; truncated: boolean; text?: string; error?: string }>
  listOnly: boolean
}

export interface WriteRulebookResult {
  ok: true
  rulebook: Rulebook
}

export interface WriteModuleResult {
  ok: true
  module: Module
}

export interface CharacterResult {
  ok: true
  character?: CharacterInstance
  template?: CharacterTemplate
  pool?: CharacterTemplate[]
}

export const api = {
  snapshot: (sessionId: string): Promise<SnapshotResponse> =>
    request<SnapshotResponse>(`${ROUTES.snapshot}${qs({ sessionId, t: Date.now() })}`),

  whoami: (sessionId: string): Promise<WhoAmIResponse> =>
    request<WhoAmIResponse>(`${ROUTES.whoami}${qs({ sessionId, t: Date.now() })}`),

  // ── 世界书 ────────────────────────────────────────────────────────────────
  loadWorld: (
    sessionId: string,
    path: string,
    name?: string,
    listOnly?: boolean,
  ): Promise<LoadWorldResult> =>
    post<LoadWorldResult>(ROUTES.world, { action: 'load', sessionId, path, name, listOnly, bind: true }),

  bindWorld: (sessionId: string, worldId: string): Promise<{ ok: true; binding: RunBinding }> =>
    post(ROUTES.world, { action: 'bind', sessionId, worldId }),

  renameWorld: (sessionId: string, worldId: string, name: string): Promise<{ ok: true }> =>
    post(ROUTES.world, { action: 'rename', sessionId, worldId, name }),

  removeWorld: (sessionId: string, worldId: string): Promise<{ ok: true; removed: boolean }> =>
    post(ROUTES.world, { action: 'remove', sessionId, worldId }),

  worldFile: (
    sessionId: string,
    worldId: string,
    rel: string,
  ): Promise<{ ok: true; rel: string; text: string; chars: number; truncated: boolean }> =>
    request(`${ROUTES.worldFile}${qs({ sessionId, worldId, rel })}`),

  // ── 规则书（世界书的子项，可多套） ─────────────────────────────────────────
  saveRulebook: (
    sessionId: string,
    payload: {
      worldId?: string
      rulebookId?: string
      style: RuleStyle
      title?: string
      pitch?: string
      markdown: string
      schema: RulesSchema
      path?: string
      select?: boolean
    },
  ): Promise<WriteRulebookResult> => post<WriteRulebookResult>(ROUTES.rulebook, { sessionId, ...payload }),

  selectRulebook: (sessionId: string, rulebookId: string, worldId?: string): Promise<{ ok: true; binding: RunBinding }> =>
    post(ROUTES.run, { sessionId, worldId, rulebookId }),

  // ── 模组集 ────────────────────────────────────────────────────────────────
  saveModule: (
    sessionId: string,
    payload: {
      worldId?: string
      moduleId?: string
      name: string
      tagline: string
      markdown: string
      scale?: 'one-shot' | 'chapter' | 'campaign'
      players?: string
      tags?: string[]
      rulebookId?: string
      select?: boolean
    },
  ): Promise<WriteModuleResult> => post<WriteModuleResult>(ROUTES.module, { sessionId, action: 'write', ...payload }),

  selectModule: (sessionId: string, moduleId: string, worldId?: string): Promise<{ ok: true; binding: RunBinding }> =>
    post(ROUTES.module, { sessionId, worldId, action: 'select', moduleId }),

  removeModule: (sessionId: string, moduleId: string, worldId?: string): Promise<{ ok: true; removed: boolean }> =>
    post(ROUTES.module, { sessionId, worldId, action: 'remove', moduleId }),

  // ── 角色卡 ────────────────────────────────────────────────────────────────
  saveCharacter: (sessionId: string, sheet: CharacterInstance): Promise<CharacterResult> =>
    post<CharacterResult>(ROUTES.character, {
      sessionId,
      name: sheet.name,
      concept: sheet.concept,
      player: sheet.player,
      attrs: sheet.attrs,
      skills: sheet.skills,
      slots: sheet.slots,
      statuses: sheet.statuses,
      journal: sheet.journal,
      notes: sheet.notes,
      initialized: sheet.initialized,
    }),

  saveToPool: (
    sessionId: string,
    sheet: CharacterInstance,
    extra?: { id?: string; moduleId?: string; generated?: boolean },
  ): Promise<CharacterResult> =>
    post<CharacterResult>(ROUTES.character, {
      sessionId,
      pool: true,
      id: extra?.id,
      moduleId: extra?.moduleId,
      generated: extra?.generated,
      name: sheet.name,
      concept: sheet.concept,
      player: sheet.player,
      attrs: sheet.attrs,
      skills: sheet.skills,
      slots: sheet.slots,
      statuses: sheet.statuses,
      journal: sheet.journal,
      notes: sheet.notes,
      initialized: sheet.initialized,
    }),

  importTemplate: (sessionId: string, templateId: string, worldId?: string): Promise<CharacterResult> =>
    post<CharacterResult>(ROUTES.pool, { sessionId, worldId, action: 'import', templateId }),

  removeTemplate: (
    sessionId: string,
    templateId: string,
    worldId?: string,
  ): Promise<{ ok: true; removed: boolean; pool: CharacterTemplate[] }> =>
    post(ROUTES.pool, { sessionId, worldId, action: 'remove', templateId }),

  // ── 四元组 ────────────────────────────────────────────────────────────────
  bindRun: (
    sessionId: string,
    patch: { worldId?: string; rulebookId?: string; moduleId?: string; templateId?: string },
  ): Promise<{ ok: true; run: RunReport; binding: RunBinding }> => post(ROUTES.run, { sessionId, ...patch }),

  // ── 判定 ──────────────────────────────────────────────────────────────────
  roll: (sessionId: string, rollRequest: RollRequest): Promise<{ ok: true; result: RollResult }> =>
    post(ROUTES.dice, { sessionId, request: rollRequest }),

  ledger: (
    sessionId: string,
    limit = 60,
  ): Promise<{ ok: true; dice: { total: number; recent: RollResult[] } }> =>
    request(`${ROUTES.dice}${qs({ sessionId, limit })}`),
}
