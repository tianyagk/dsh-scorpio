/**
 * 可拖拽的悬浮判定卡（`ctx.slots` → `shell.overlay`）。
 *
 * 判定是贯穿整场推演的底层能力，不该被埋在某个页签里：它是一张**可拖拽**的小卡，
 * 停在整个界面之上（shell.overlay 是 frame-wide 的浮层，条目自己 opt-in 指针事件），
 * 折叠成一个 🎲 按钮，展开就是「命名检定 / 骰式 / 难度 / 对抗」的完整掷骰面板。
 *
 * 只在**天蝎座会话**里出现：先问 `/scorpio/whoami` 是否 scorpio，不是就不渲染。
 * 位置用 localStorage 记忆（按会话隔离），拖动时限制在视口内。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, type SnapshotResponse } from './api.ts'
import { ensureCss } from './styles.ts'
import { Banner, Btn, Field, MetaRow, Segmented, relTime } from './ui.tsx'
import type { RollResult } from '../shared/model.ts'

export interface DiceCardProps {
  visible: boolean
  sessionId: string | undefined
  /** 打开/关闭时是否要通知外层（页签里也有一个入口）。 */
  onRequestRefresh?: () => void
}

interface Pos {
  x: number
  y: number
}

const POS_KEY = (sessionId: string): string => `dsh-scorpio:overlay:${sessionId}`
const MIN_KEY = 'dsh-scorpio:overlay:min'
const ALPHA_KEY = 'dsh-scorpio:overlay:alpha'
/** 悬浮卡底色不透明度的取值范围与默认值。 */
const ALPHA_MIN = 0.35
const ALPHA_MAX = 1
const ALPHA_DEFAULT = 0.82

const clampAlpha = (value: number): number =>
  Number.isFinite(value) ? Math.min(ALPHA_MAX, Math.max(ALPHA_MIN, value)) : ALPHA_DEFAULT

function loadAlpha(): number {
  try {
    const raw = window.localStorage.getItem(ALPHA_KEY)
    return raw === null ? ALPHA_DEFAULT : clampAlpha(Number(raw))
  } catch {
    return ALPHA_DEFAULT
  }
}

function saveAlpha(value: number): void {
  try {
    window.localStorage.setItem(ALPHA_KEY, String(value))
  } catch {
    /* 忽略 */
  }
}

function loadPos(sessionId: string): Pos | undefined {
  try {
    const raw = window.localStorage.getItem(POS_KEY(sessionId))
    if (raw === null) return undefined
    const parsed = JSON.parse(raw) as Pos
    if (Number.isFinite(parsed.x) && Number.isFinite(parsed.y)) return parsed
  } catch {
    /* localStorage 不可用就忽略 */
  }
  return undefined
}

function savePos(sessionId: string, pos: Pos): void {
  try {
    window.localStorage.setItem(POS_KEY(sessionId), JSON.stringify(pos))
  } catch {
    /* 忽略 */
  }
}

function loadMin(): boolean {
  try {
    return window.localStorage.getItem(MIN_KEY) === '1'
  } catch {
    return false
  }
}

/** 判定卡主体。 */
export function DiceCard(props: DiceCardProps): React.ReactElement | null {
  const sessionId = props.sessionId
  const [enabled, setEnabled] = useState(false)
  const [min, setMin] = useState<boolean>(loadMin)
  const [data, setData] = useState<SnapshotResponse | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [expression, setExpression] = useState('')
  const [checkId, setCheckId] = useState('')
  const [difficulty, setDifficulty] = useState('')
  const [modifier, setModifier] = useState('0')
  const [action, setAction] = useState('')
  const [opposedName, setOpposedName] = useState('')
  const [result, setResult] = useState<RollResult | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [pos, setPos] = useState<Pos | undefined>(undefined)
  const [alpha, setAlpha] = useState<number>(loadAlpha)
  const drag = useRef<{ dx: number; dy: number } | undefined>(undefined)
  const cardRef = useRef<HTMLDivElement | null>(null)

  // 探测当前会话是否天蝎座；不是就不渲染（也不轮询）。
  useEffect(() => {
    let alive = true
    if (sessionId === undefined || sessionId === '') {
      setEnabled(false)
      return
    }
    const probe = async (): Promise<void> => {
      try {
        const who = await api.whoami(sessionId)
        if (alive) setEnabled(who.scorpio === true)
      } catch {
        if (alive) setEnabled(false)
      }
    }
    void probe()
    const timer = window.setInterval(() => void probe(), 30_000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [sessionId])

  const refresh = useCallback(async (): Promise<void> => {
    if (sessionId === undefined || sessionId === '' || !enabled) return
    try {
      const next = await api.snapshot(sessionId)
      setData(next)
      setError(undefined)
      if (expression === '' && next.rulebook !== undefined) setExpression(next.rulebook.schema.baseDice)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [sessionId, enabled, expression])

  useEffect(() => {
    if (!enabled || !props.visible) return
    void refresh()
    const timer = window.setInterval(() => void refresh(), 8000)
    return () => window.clearInterval(timer)
  }, [enabled, props.visible, refresh])

  // 位置：首次挂载时放到右下角，之后读记忆值。
  useEffect(() => {
    if (sessionId === undefined || sessionId === '') return
    const stored = loadPos(sessionId)
    setPos(stored ?? { x: Math.max(16, window.innerWidth - 380), y: Math.max(16, window.innerHeight - 520) })
  }, [sessionId])

  // 拖拽：pointer 事件挂在卡片头部。
  useEffect(() => {
    const onMove = (event: PointerEvent): void => {
      const offset = drag.current
      if (offset === undefined) return
      const width = cardRef.current?.offsetWidth ?? 320
      const height = cardRef.current?.offsetHeight ?? 200
      const x = Math.min(Math.max(8, event.clientX - offset.dx), Math.max(8, window.innerWidth - width - 8))
      const y = Math.min(Math.max(8, event.clientY - offset.dy), Math.max(8, window.innerHeight - 48))
      setPos({ x, y })
    }
    const onUp = (): void => {
      if (drag.current !== undefined) {
        drag.current = undefined
        setPos((current) => {
          if (current !== undefined && sessionId !== undefined) savePos(sessionId, current)
          return current
        })
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [sessionId])

  const schema = data?.rulebook?.schema
  const character = data?.character
  const skills = useMemo(() => schema?.skills ?? [], [schema])

  if (sessionId === undefined || !enabled || pos === undefined) return null

  const toggleMin = (): void => {
    const next = !min
    setMin(next)
    try {
      window.localStorage.setItem(MIN_KEY, next ? '1' : '0')
    } catch {
      /* 忽略 */
    }
  }

  const roll = async (): Promise<void> => {
    if (sessionId === undefined) return
    setBusy(true)
    setError(undefined)
    try {
      const response = await api.roll(sessionId, {
        ...(checkId === '' ? { expression: expression || (schema?.baseDice ?? '1d100') } : { check: checkId }),
        ...(difficulty.trim() === '' ? {} : { difficulty: Number(difficulty) }),
        modifier: Number(modifier === '' ? 0 : modifier),
        action: action === '' ? '悬浮卡掷骰' : action,
        actor: 'user',
        ...(opposedName.trim() === '' ? {} : { opposed: { name: opposedName.trim() } }),
      })
      setResult(response.result)
      void refresh()
      props.onRequestRefresh?.()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const startDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    const box = cardRef.current?.getBoundingClientRect()
    if (box === undefined) return
    drag.current = { dx: event.clientX - box.left, dy: event.clientY - box.top }
  }

  // 折叠态：只剩一个可拖拽的圆钮。
  if (min) {
    return React.createElement(
      'div',
      {
        ref: cardRef,
        className: 'sc-float sc-float-min',
        style: { left: pos.x, top: pos.y },
        onPointerDown: startDrag,
      },
      React.createElement(
        'button',
        { className: 'sc-float-btn', title: '展开判定卡（可拖拽）', onClick: toggleMin },
        '🎲',
      ),
    )
  }

  return React.createElement(
    'div',
    {
      ref: cardRef,
      className: 'sc-float',
      style: { left: pos.x, top: pos.y, ['--sc-float-alpha' as string]: String(alpha) } as React.CSSProperties,
    },
    // 标题栏 = 拖拽把手
    React.createElement(
      'div',
      { className: 'sc-float-head', onPointerDown: startDrag, title: '按住拖动' },
      React.createElement('span', { className: 'sc-float-grip' }, '⣿'),
      React.createElement('span', { className: 'sc-float-title' }, '判定'),
      schema === undefined ? null : React.createElement('span', { className: 'sc-chip sc-tiny' }, schema.baseDice),
      React.createElement('span', { className: 'sc-spacer' }),
      React.createElement(
        'span',
        {
          className: 'sc-float-alpha',
          title: '悬浮卡底色的不透明度（双击恢复默认）',
          onPointerDown: (event: React.PointerEvent<HTMLSpanElement>) => event.stopPropagation(),
          onDoubleClick: () => {
            setAlpha(ALPHA_DEFAULT)
            saveAlpha(ALPHA_DEFAULT)
          },
        },
        React.createElement(
          'input',
          {
            type: 'range',
            min: String(ALPHA_MIN),
            max: String(ALPHA_MAX),
            step: '0.02',
            value: String(alpha),
            'aria-label': '悬浮卡不透明度',
            onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
              const next = clampAlpha(Number(event.target.value))
              setAlpha(next)
              saveAlpha(next)
            },
          } as React.InputHTMLAttributes<HTMLInputElement>,
        ),
        React.createElement('span', { className: 'sc-float-alpha-label' }, `${Math.round(alpha * 100)}%`),
      ),
      React.createElement(
        Btn,
        { size: 'sm', variant: 'ghost', onClick: toggleMin, title: '折叠' },
        '—',
      ),
    ),

    React.createElement(
      'div',
      { className: 'sc-float-body sc-scroll' },
      data === undefined
        ? React.createElement('div', { className: 'sc-hint' }, '读取工作区状态…')
        : data.run.ready
          ? null
          : React.createElement(Banner, {
              tone: 'warn',
              text: `开局四元组未齐备：还缺 ${data.run.missing.join('、')}。仍可试掷，但正式推演前请先补齐。`,
            }),
      schema === undefined
        ? React.createElement('div', { className: 'sc-hint' }, '还没有选定规则书：试掷会用裸骰式。')
        : React.createElement(MetaRow, {
            items: [
              { k: '规则', v: schema.system },
              ...(character === undefined ? [] : [{ k: '角色', v: character.name || '未命名' }]),
            ],
          }),
      React.createElement(
        'div',
        { className: 'sc-grid', 'data-cols': '2' },
        React.createElement(
          Field,
          { label: '命名检定' },
          React.createElement(
            'select',
            { value: checkId, onChange: (event: React.ChangeEvent<HTMLSelectElement>) => setCheckId(event.target.value) },
            React.createElement('option', { value: '' }, '— 用骰式 —'),
            ...skills.map((skill) =>
              React.createElement('option', { key: skill.id, value: skill.id }, `${skill.label}（${skill.id}）`),
            ),
          ),
        ),
        React.createElement(
          Field,
          { label: '骰式' },
          React.createElement('input', {
            value: expression,
            placeholder: schema?.baseDice ?? '1d100',
            spellCheck: false,
            onChange: (event: React.ChangeEvent<HTMLInputElement>) => setExpression(event.target.value),
          }),
        ),
        React.createElement(
          Field,
          { label: '难度' },
          React.createElement('input', {
            value: difficulty,
            inputMode: 'numeric',
            placeholder: schema === undefined ? '' : String(schema.defaultDifficulty),
            onChange: (event: React.ChangeEvent<HTMLInputElement>) => setDifficulty(event.target.value),
          }),
        ),
        React.createElement(
          Field,
          { label: '修正' },
          React.createElement('input', {
            value: modifier,
            inputMode: 'numeric',
            onChange: (event: React.ChangeEvent<HTMLInputElement>) => setModifier(event.target.value),
          }),
        ),
      ),
      React.createElement(
        'div',
        { className: 'sc-row' },
        React.createElement(
          Field,
          { label: '行动' },
          React.createElement('input', {
            value: action,
            placeholder: '如：撬开上锁的抽屉',
            onChange: (event: React.ChangeEvent<HTMLInputElement>) => setAction(event.target.value),
          }),
        ),
        React.createElement(
          Field,
          { label: '对抗（可选）' },
          React.createElement('input', {
            value: opposedName,
            placeholder: '对手名',
            onChange: (event: React.ChangeEvent<HTMLInputElement>) => setOpposedName(event.target.value),
          }),
        ),
      ),
      React.createElement(
        'div',
        { className: 'sc-row' },
        React.createElement(Btn, { variant: 'primary', disabled: busy, onClick: () => void roll() }, busy ? React.createElement('span', { className: 'sc-spin' }) : '🎲', '掷骰'),
        React.createElement('span', { className: 'sc-tiny sc-muted' }, '结果写入 .scorpio/dice.jsonl'),
      ),
      error === undefined ? null : React.createElement(Banner, { tone: 'err', text: error }),
      result === undefined ? null : React.createElement(RollSummary, { result }),
      (data?.dice.recent.length ?? 0) > 0
        ? React.createElement(
            'div',
            { className: 'sc-float-history' },
            React.createElement('div', { className: 'sc-tiny sc-muted' }, `最近判定（共 ${data?.dice.total ?? 0} 条）`),
            ...(data?.dice.recent.slice(0, 4) ?? []).map((entry) =>
              React.createElement(
                'div',
                { key: entry.id, className: 'sc-float-hrow' },
                React.createElement('span', { className: 'sc-dim sc-ellipsis' }, entry.check?.label ?? entry.action ?? '判定'),
                React.createElement('span', { className: `sc-bold sc-${entry.outcome === 'success' || entry.outcome === 'critical-success' ? 'ok' : entry.outcome === 'tie' ? 'warn' : 'err'}` }, String(entry.roll.total)),
                React.createElement('span', { className: 'sc-tiny sc-muted sc-nowrap' }, relTime(entry.ts)),
              ),
            ),
          )
        : null,
    ),
  )
}

/** 一次判定的紧凑结果卡（与侧边栏里的风格一致）。 */
function RollSummary(props: { result: RollResult }): React.ReactElement {
  const { result } = props
  return React.createElement(
    'div',
    { className: 'sc-float-result' },
    React.createElement('div', { className: 'sc-dice-verdict', 'data-outcome': result.outcome }, result.verdict),
    React.createElement(
      'div',
      { className: 'sc-row sc-row-wrap' },
      React.createElement(
        'div',
        { className: 'sc-faces' },
        ...result.roll.faces.map((face, index) =>
          React.createElement(
            'span',
            { key: `f${index}`, className: 'sc-face', 'data-kept': face.kept },
            String(face.value),
          ),
        ),
      ),
      React.createElement('span', { className: 'sc-chip sc-mono' }, result.roll.spec.normalized),
      React.createElement('span', { className: 'sc-chip sc-mono' }, `合计 ${result.roll.total}`),
      result.roll.successes === undefined
        ? null
        : React.createElement('span', { className: 'sc-chip sc-mono' }, `成功数 ${result.roll.successes}`),
      result.roll.target === undefined
        ? null
        : React.createElement('span', { className: 'sc-chip sc-mono' }, `目标 ${result.roll.target}`),
      result.difficultyLabel === undefined
        ? null
        : React.createElement('span', { className: 'sc-chip', 'data-tone': 'gold' }, result.difficultyLabel),
    ),
  )
}
