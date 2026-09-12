/**
 * dsh-scorpio — 浏览器半区入口。
 *
 * 两处 UI：
 *  1. `ctx.betterSidebar` 注册「天蝎座」页签 —— 三个子页：【世界书】（规则书作为它的
 *     子项折叠在下面）、【模组集】、【角色卡】；
 *  2. `ctx.slots` 注册 `shell.overlay` 的**可拖拽悬浮判定卡** —— 判定是贯穿整场推演
 *     的底层能力，随时可用，不藏在页签里。
 *
 * 「只在天蝎座生效」由三件事共同保证：
 *  1. 页签与悬浮卡都先问 `/scorpio/whoami`：非 Scorpio 会话页签只渲染说明、悬浮卡
 *     直接不出现；
 *  2. `available` 谓词让「+」菜单在非 Scorpio 会话里禁用该页签；
 *  3. 宿主侧所有 `/scorpio/*` 路由对非 Scorpio 会话一律 403。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { api, type SnapshotResponse } from './api.ts'
import { ensureCss } from './styles.ts'
import { Banner, Btn, Section, useTheme } from './ui.tsx'
import { useScorpioState } from './useScorpio.ts'
import { DiceCard } from './DiceCard.tsx'
import { WorldbookPage } from './WorldbookPage.tsx'
import { ModulePage } from './ModulePage.tsx'
import { CharacterPage } from './CharacterPage.tsx'
import { OVERLAY_ID, PRESET_ID, TAB_ID } from '../shared/model.ts'

// ── 宿主服务结构面 ─────────────────────────────────────────────────────────

interface SessionScope {
  sessionId: string
  cwd?: string
  repoRoot?: string
}

interface TabProps {
  ctx: { get?(name: string): unknown }
  scope: SessionScope
  tab: { id: string; type: string }
  visible: boolean
}

interface TabDescriptor {
  id: string
  title: string | (() => string)
  icon?: React.ReactNode | ((size: number) => React.ReactNode)
  order?: number
  hidden?: boolean
  available?: (ctx: unknown, scope: SessionScope, state: unknown) => boolean
  badge?: (ctx: unknown, scope: SessionScope, state: unknown) => string | number | null | undefined
  single?: boolean
  settings?: { pluginToggles?: Array<Record<string, unknown>> }
  component: (props: TabProps) => React.ReactNode
}

interface SidebarService {
  registerTab(descriptor: TabDescriptor): () => void
}

/** 会话列表的只读快照（`useSessions` 的标准 selector 用法）。 */
interface SessionSummaryLike {
  id?: string
  current?: boolean
  active?: boolean
}
/** 形态取自 `@deepseek-ai/dsh-client-runtime` 的 SessionListState（只用其中两个字段）。 */
interface SessionListStateLike {
  ids?: string[]
  byId?: Record<string, SessionSummaryLike>
  current?: string
}

interface SlotRegistration {
  name: string
  id: string
  order?: number
  label?: string
}

interface SlotsService {
  inject(key: string, callback: () => () => void): () => void
  register(registration: SlotRegistration, component: (props: unknown) => React.ReactNode): () => void
}

interface PluginContext {
  betterSidebar: SidebarService
  effect(fn: () => void | (() => void), label?: string): void
  get(name: string): unknown
}

export const name = TAB_ID
export const inject = ['betterSidebar']

// ── 预设判定缓存（模块级 + 订阅，供 available/badge 同步读取） ────────────────

type Probe = { scorpio: boolean; preset?: string; cwd?: string; unresolvable?: string; error?: string }

const probes = new Map<string, Probe>()
const listeners = new Set<() => void>()

function setProbe(sessionId: string, probe: Probe): void {
  const previous = probes.get(sessionId)
  if (
    previous !== undefined &&
    previous.scorpio === probe.scorpio &&
    previous.preset === probe.preset &&
    previous.unresolvable === probe.unresolvable &&
    previous.error === probe.error
  ) {
    return
  }
  probes.set(sessionId, probe)
  for (const listener of listeners) listener()
}

export async function probeSession(sessionId: string): Promise<Probe> {
  try {
    const who = await api.whoami(sessionId)
    const probe: Probe = {
      scorpio: who.scorpio === true,
      preset: who.preset,
      cwd: who.cwd,
      ...(who.unresolvable === undefined ? {} : { unresolvable: who.unresolvable }),
    }
    setProbe(sessionId, probe)
    return probe
  } catch (cause) {
    const probe: Probe = { scorpio: false, error: cause instanceof Error ? cause.message : String(cause) }
    setProbe(sessionId, probe)
    return probe
  }
}

function useProbe(sessionId: string | undefined): Probe | undefined {
  const [, force] = useState(0)
  useEffect(() => {
    const listener = (): void => force((n) => n + 1)
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }, [])
  useEffect(() => {
    if (sessionId !== undefined && sessionId !== '' && probes.get(sessionId) === undefined) {
      void probeSession(sessionId)
    }
  }, [sessionId])
  return sessionId === undefined ? undefined : probes.get(sessionId)
}

/** 页签角标：开局四元组还缺几环（最多显示 4）。 */
const badgeCounts = new Map<string, number>()
const badgeTimers = new Map<string, number>()

function ensureBadgePolling(sessionId: string): void {
  if (badgeTimers.has(sessionId)) return
  const tick = async (): Promise<void> => {
    if (probes.get(sessionId)?.scorpio !== true) {
      badgeCounts.set(sessionId, 0)
      return
    }
    try {
      const state = await api.snapshot(sessionId)
      // 角标 = 需要玩家确认的角色属性数（「轮到你确认了」），不是"面板不可用"。
      const pending = state.character?.attrs.filter((attr) => attr.pending === true).length ?? 0
      badgeCounts.set(sessionId, pending)
    } catch {
      badgeCounts.set(sessionId, 0)
    }
  }
  badgeTimers.set(
    sessionId,
    window.setInterval(() => void tick(), 20_000),
  )
  void tick()
}

// ── 注册 ───────────────────────────────────────────────────────────────────

export function apply(ctx: PluginContext): void {
  ensureCss()
  try {
    console.log('[dsh-scorpio] client v0.2.0 loaded（三个子页 + 悬浮判定卡）')
  } catch {
    /* console 不可用 */
  }

  ctx.effect(
    () =>
      ctx.betterSidebar.registerTab({
        id: TAB_ID,
        title: () => '天蝎座',
        icon: (size: number): React.ReactNode =>
          React.createElement('span', { style: { fontSize: Math.round(size * 0.8), lineHeight: 1 } }, '🦂'),
        order: 58,
        single: true,
        /**
         * 页签能否被选中 —— **只看当前会话选的 Agent 预设是不是天蝎座**。
         * 与世界书/规则书/模组/角色卡是否初始化完成完全无关：那四样只决定
         * 「能不能开演」，不决定「能不能打开面板」。其他预设（标准/PTC/极简/创造…）
         * 下这个页签不可选中；天蝎座会话则直接解锁。
         */
        available: (_ctx: unknown, scope: SessionScope): boolean => {
          const known = probes.get(scope.sessionId)
          if (known === undefined) {
            // 预设还没探测出来：先放行（面板内部会显示"检测预设…"），避免菜单闪一下又消失。
            void probeSession(scope.sessionId)
            return true
          }
          // 预设被删除的会话也保留入口：点进去才能看到"该怎么修"的说明。
          return known.scorpio || known.unresolvable !== undefined
        },
        badge: (_ctx: unknown, scope: SessionScope): string | number | null => {
          if (probes.get(scope.sessionId)?.scorpio !== true) return null
          ensureBadgePolling(scope.sessionId)
          const count = badgeCounts.get(scope.sessionId) ?? 0
          return count > 0 ? count : null
        },
        settings: { pluginToggles: [] },
        component: (props: TabProps): React.ReactNode => React.createElement(App, props),
      }),
    'dsh-scorpio: 天蝎座页签',
  )

  // 悬浮判定卡：注册进 frame-wide 的浮层，条目自己接管指针事件。
  const slots = ctx.get('slots') as SlotsService | undefined
  if (slots === undefined) {
    try {
      console.warn('[dsh-scorpio] slots 服务不可用 —— 悬浮判定卡未注册（页签仍可用）')
    } catch {
      /* console 不可用 */
    }
    return
  }
  ctx.effect(
    () =>
      slots.inject('shell.overlay', () =>
        slots.register({ name: 'shell.overlay', id: OVERLAY_ID, order: 40, label: '天蝎座判定' }, (raw) => {
          const props = raw as {
            visible?: boolean
            useSessions?: (selector: (state: SessionListStateLike) => string | undefined) => string | undefined
          }
          return React.createElement(DiceOverlay, { useSessions: props.useSessions })
        }),
      ),
    'dsh-scorpio: 悬浮判定卡',
  )
}

/** 浮层条目：自己解析「当前会话」，再交给 DiceCard。 */
function DiceOverlay(props: {
  useSessions?: (selector: (state: SessionListStateLike) => string | undefined) => string | undefined
}): React.ReactElement | null {
  const selectCurrent = useCallback((state: SessionListStateLike): string | undefined => {
    if (typeof state.current === 'string' && state.current !== '') return state.current
    const byId = state.byId ?? {}
    for (const id of state.ids ?? Object.keys(byId)) {
      if (byId[id]?.current === true || byId[id]?.active === true) return id
    }
    return undefined
  }, [])
  let sessionId: string | undefined
  if (props.useSessions !== undefined) {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- useSessions 是外部传进来的 hook
    sessionId = props.useSessions(selectCurrent)
  }
  return React.createElement(DiceCard, { visible: true, sessionId })
}

// ── 页签主体 ───────────────────────────────────────────────────────────────

type PageKey = 'worldbook' | 'module' | 'character'

function App(props: TabProps): React.ReactElement {
  const sessionId = props.scope.sessionId
  const visible = props.visible
  const theme = useTheme()
  const probe = useProbe(sessionId)
  const state = useScorpioState(sessionId, visible)
  const [page, setPage] = useState<PageKey>('worldbook')
  const [busy, setBusy] = useState(false)
  const [localError, setLocalError] = useState<string | undefined>(undefined)

  const ok = probe?.scorpio === true
  const data: SnapshotResponse | undefined = state.data

  // 首次拿到四元组进度时，自动落到最该动的那个子页。
  const landed = React.useRef(false)
  useEffect(() => {
    if (landed.current || data === undefined) return
    if (data.binding.worldId === undefined) setPage('worldbook')
    else if (data.binding.moduleId === undefined) setPage('module')
    else if (data.character === undefined || data.character.name === '') setPage('character')
    landed.current = true
  }, [data])

  const wrap = useCallback(
    async (action: () => Promise<void>): Promise<void> => {
      setBusy(true)
      setLocalError(undefined)
      try {
        await action()
        await state.afterWrite()
      } catch (cause) {
        setLocalError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setBusy(false)
      }
    },
    [state],
  )

  const error = localError ?? state.error ?? probe?.error
  const worldId = data?.binding.worldId

  const steps = useMemo(() => {
    const run = data?.run
    return [
      { label: '世界书', done: run?.world !== undefined, on: run?.world === undefined },
      { label: '规则书', done: run?.rulebook !== undefined, on: run?.world !== undefined && run?.rulebook === undefined },
      { label: '模组', done: run?.module !== undefined, on: run?.rulebook !== undefined && run?.module === undefined },
      {
        label: '角色卡',
        done: run?.character !== undefined && run.character.name !== '',
        on: run?.module !== undefined && run?.character?.name === undefined,
      },
    ]
  }, [data])

  const head = React.createElement(
    'div',
    { className: 'sc-top' },
    React.createElement(
      'div',
      { className: 'sc-top-row' },
      React.createElement('span', { className: 'sc-brand' }, React.createElement('span', { className: 'sc-mark' }, '🦂'), '天蝎座 Scorpio'),
      React.createElement('span', { className: 'sc-spacer' }),
      probe === undefined
        ? React.createElement('span', { className: 'sc-chip' }, '检测预设…')
        : ok
          ? React.createElement('span', { className: 'sc-chip', 'data-tone': 'ok' }, '预设已启用')
          : React.createElement('span', { className: 'sc-chip', 'data-tone': 'err' }, `预设 ${probe.preset ?? '未知'}`),
      ok && data !== undefined
        ? React.createElement(
            'span',
            {
              className: 'sc-chip',
              'data-tone': data.run.ready ? 'ok' : 'warn',
              title: data.run.ready ? '四元组齐备' : `面板已解锁；开局四元组还缺：${data.run.missing.join('、')}`,
            },
            data.run.ready ? '可开演' : '序章未齐',
          )
        : null,
      React.createElement(
        Btn,
        { size: 'sm', variant: 'ghost', disabled: state.loading, onClick: () => void state.refresh(), title: '刷新' },
        state.loading ? React.createElement('span', { className: 'sc-spin' }) : '⟳',
      ),
    ),
    ok
      ? React.createElement(
          'div',
          { className: 'sc-steps' },
          ...steps.map((step) =>
            React.createElement(
              'span',
              { key: step.label, className: 'sc-step', 'data-done': step.done, 'data-on': !step.done && step.on },
              `${step.done ? '✓' : '·'} ${step.label}`,
            ),
          ),
        )
      : null,
  )

  if (probe !== undefined && probe.unresolvable !== undefined) {
    return React.createElement(
      'div',
      { className: 'sc-root', 'data-theme': theme },
      head,
      React.createElement(
        'div',
        { className: 'sc-body sc-scroll' },
        React.createElement(
          Section,
          { title: '这个会话的预设已被删除' },
          React.createElement(Banner, { tone: 'err', text: probe.unresolvable }),
          React.createElement(
            'div',
            { className: 'sc-hint' },
            '怎么修：点左侧「新会话」（或换一个工作区开会话），在「Agent 预设」里选择「天蝎座 Scorpio」。' +
              '注意：在**同一个会话**里改预设不会生效——界面会把改动记成一个“切换预设”动作，而它需要恢复那个已删除的预设，于是失败并把会话卡在原地。',
          ),
        ),
      ),
    )
  }

  if (probe !== undefined && !ok && probe.error === undefined) {
    return React.createElement(
      'div',
      { className: 'sc-root', 'data-theme': theme },
      head,
      React.createElement(
        'div',
        { className: 'sc-body sc-scroll' },
        React.createElement(
          Section,
          { title: '天蝎座模式未启用' },
          React.createElement(Banner, {
            tone: 'info',
            text: `当前会话的 Agent 预设是「${probe.preset ?? '未知'}」。天蝎座配置窗只在 Scorpio 预设的会话里工作。`,
          }),
          React.createElement(
            'div',
            { className: 'sc-hint' },
            `新建会话时在「Agent 预设」里选择「天蝎座 Scorpio」（id: ${PRESET_ID}），即可使用【世界书】【模组集】【角色卡】三个子页与悬浮判定卡。`,
          ),
        ),
      ),
    )
  }

  if (!ok) {
    return React.createElement(
      'div',
      { className: 'sc-root', 'data-theme': theme },
      head,
      React.createElement(
        'div',
        { className: 'sc-body sc-scroll' },
        React.createElement(
          Section,
          { title: '无法读取会话状态' },
          React.createElement(Banner, { tone: 'err', text: error ?? '宿主返回了空结果。' }),
          React.createElement('div', { className: 'sc-hint' }, '如果 dsh web 刚重启过，请刷新页面。'),
        ),
      ),
    )
  }

  const body =
    data === undefined
      ? React.createElement(
          'div',
          { className: 'sc-body' },
          React.createElement('div', { className: 'sc-empty' }, state.loading ? '正在读取工作区状态…' : '暂无数据'),
        )
      : page === 'worldbook'
        ? React.createElement(WorldbookPage, {
            sessionId,
            data,
            busy,
            onLoad: (path: string, name: string, listOnly: boolean) =>
              wrap(async () => void (await api.loadWorld(sessionId, path, name === '' ? undefined : name, listOnly))),
            onBind: (id: string) => wrap(async () => void (await api.bindWorld(sessionId, id))),
            onRename: (id: string, name: string) => wrap(async () => void (await api.renameWorld(sessionId, id, name))),
            onRemove: (id: string) => wrap(async () => void (await api.removeWorld(sessionId, id))),
            onSelectRulebook: (rulebookId: string, id: string) =>
              wrap(async () => void (await api.selectRulebook(sessionId, rulebookId, id))),
            onSaved: state.afterWrite,
            onError: setLocalError,
          })
        : page === 'module'
          ? React.createElement(ModulePage, {
              sessionId,
              data,
              busy,
              onSelect: (moduleId: string) =>
                wrap(async () => void (await api.selectModule(sessionId, moduleId, worldId))),
              onRemove: (moduleId: string) =>
                wrap(async () => void (await api.removeModule(sessionId, moduleId, worldId))),
              onSaved: state.afterWrite,
              onError: setLocalError,
            })
          : React.createElement(CharacterPage, {
              sessionId,
              data,
              busy,
              onImport: (templateId: string) =>
                wrap(async () => void (await api.importTemplate(sessionId, templateId, worldId))),
              onRemoveTemplate: (templateId: string) =>
                wrap(async () => void (await api.removeTemplate(sessionId, templateId, worldId))),
              onSaved: state.afterWrite,
              onError: setLocalError,
            })

  return React.createElement(
    'div',
    { className: 'sc-root', 'data-theme': theme },
    head,
    React.createElement(
      'div',
      { className: 'sc-tabs' },
      ...[
        {
          key: 'worldbook' as PageKey,
          label: '世界书',
          hint: data === undefined ? '' : `${data.worlds.length}`,
        },
        {
          key: 'module' as PageKey,
          label: '模组集',
          hint: data === undefined ? '' : `${data.modules.length}`,
        },
        {
          key: 'character' as PageKey,
          label: '角色卡',
          hint: data === undefined ? '' : data.character?.name === undefined || data.character.name === '' ? `${data.pool.length}` : data.character.name,
        },
      ].map((item) =>
        React.createElement(
          'button',
          { key: item.key, className: 'sc-tab', 'data-on': page === item.key, onClick: () => setPage(item.key) },
          item.label,
          React.createElement('span', { className: 'sc-count' }, item.hint),
        ),
      ),
    ),
    error === undefined
      ? null
      : React.createElement(
          'div',
          { style: { padding: '0 10px 8px' } },
          React.createElement(Banner, {
            tone: 'err',
            text: error,
            right: React.createElement(Btn, { size: 'sm', variant: 'ghost', onClick: () => setLocalError(undefined) }, '×'),
          }),
        ),
    ok && data !== undefined && !data.run.ready
      ? React.createElement(
          'div',
          { className: 'sc-readiness' },
          React.createElement(
            'div',
            { className: 'sc-readiness-head' },
            React.createElement('span', { className: 'sc-bold sc-small' }, '开局序章未齐 · 面板已解锁'),
            React.createElement('span', { className: 'sc-spacer' }),
            React.createElement('span', { className: 'sc-tiny sc-muted' }, '三个子页随时可浏览与编辑'),
          ),
          React.createElement(
            'div',
            { className: 'sc-readiness-steps' },
            ...[
              { key: 'world', label: '世界书', page: 'worldbook' as PageKey },
              { key: 'rulebook', label: '规则书', page: 'worldbook' as PageKey },
              { key: 'module', label: '模组', page: 'module' as PageKey },
              { key: 'character', label: '角色卡', page: 'character' as PageKey },
            ].map((item) =>
              React.createElement(
                'button',
                {
                  key: item.key,
                  className: 'sc-readiness-step',
                  'data-done': !data.run.missing.includes(item.key as 'world'),
                  title: data.run.missing.includes(item.key as 'world') ? '点击前往补上' : '已完成',
                  onClick: () => setPage(item.page),
                },
                `${data.run.missing.includes(item.key as 'world') ? '○' : '●'} ${item.label}`,
              ),
            ),
          ),
          React.createElement('div', { className: 'sc-readiness-next' }, data.run.next),
        )
      : null,
    body,
  )
}
