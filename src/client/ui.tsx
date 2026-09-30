/**
 * 客户端 UI 原语：按钮、字段、分段控件、markdown 渲染、主题探测。
 *
 * 刻意不引入任何 markdown 依赖：这里只需要渲染规则书正文（标题、列表、表格、
 * 引用、代码块、粗斜体、行内代码），一个 60 行的确定性渲染器足够，也让浏览器
 * bundle 保持零额外体积。
 */
import React, { useEffect, useState, type ReactNode } from 'react'

/** 探测当前主题：优先读 GUI 的主题 token，其次跟随系统。 */
export function useTheme(): 'light' | 'dark' {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => detectTheme())
  useEffect(() => {
    if (typeof window === 'undefined') return
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)')
    const onChange = (): void => setTheme(detectTheme())
    mq?.addEventListener?.('change', onChange)
    const observer = new MutationObserver(onChange)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] })
    if (document.body !== null) {
      observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] })
    }
    const timer = window.setInterval(onChange, 4000)
    return () => {
      mq?.removeEventListener?.('change', onChange)
      observer.disconnect()
      window.clearInterval(timer)
    }
  }, [])
  return theme
}

function detectTheme(): 'light' | 'dark' {
  if (typeof document !== 'undefined') {
    const root = document.documentElement
    const marked = `${root.getAttribute('data-theme') ?? ''} ${root.className} ${document.body?.className ?? ''}`
    if (/dark/i.test(marked)) return 'dark'
    if (/light/i.test(marked)) return 'light'
    try {
      const token = getComputedStyle(root).getPropertyValue('--dsw-alias-bg-base').trim()
      const rgb = parseColor(token)
      if (rgb !== undefined) {
        const [r, g, b] = rgb
        return 0.299 * r + 0.587 * g + 0.114 * b < 140 ? 'dark' : 'light'
      }
    } catch {
      /* 取不到就跟随系统 */
    }
  }
  if (typeof window !== 'undefined') {
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches === true ? 'dark' : 'light'
  }
  return 'dark'
}

function parseColor(value: string): [number, number, number] | undefined {
  if (value === '') return undefined
  const hex = /^#([0-9a-f]{6})$/i.exec(value)
  if (hex !== null && hex[1] !== undefined) {
    const n = Number.parseInt(hex[1], 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  }
  const rgb = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(value)
  if (rgb !== null && rgb[1] !== undefined && rgb[2] !== undefined && rgb[3] !== undefined) {
    return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
  }
  return undefined
}

// ── 按钮 / 字段 ────────────────────────────────────────────────────────────

export function Btn(props: {
  children?: ReactNode
  onClick?: () => void
  variant?: 'default' | 'primary' | 'ghost'
  size?: 'md' | 'sm'
  tone?: 'default' | 'danger'
  disabled?: boolean
  title?: string
}): React.ReactElement {
  return React.createElement(
    'button',
    {
      className: 'sc-btn',
      'data-variant': props.variant ?? 'default',
      'data-size': props.size ?? 'md',
      'data-tone': props.tone ?? 'default',
      disabled: props.disabled === true,
      title: props.title,
      onClick: props.onClick,
    },
    props.children,
  )
}

export function Field(props: {
  label: string
  hint?: string
  children?: ReactNode
}): React.ReactElement {
  return React.createElement(
    'label',
    { className: 'sc-field', style: { display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 0 } },
    React.createElement('span', { className: 'sc-small sc-muted' }, props.label),
    props.children,
    props.hint === undefined ? null : React.createElement('span', { className: 'sc-tiny sc-muted' }, props.hint),
  )
}

export function Segmented(props: {
  value: string
  options: Array<{ value: string; label: string; badge?: number }>
  onChange: (value: string) => void
}): React.ReactElement {
  return React.createElement(
    'div',
    { className: 'sc-tabs', style: { border: 'none', background: 'transparent', padding: 0 } },
    ...props.options.map((option) =>
      React.createElement(
        'button',
        {
          key: option.value,
          className: 'sc-tab',
          'data-on': option.value === props.value,
          onClick: () => props.onChange(option.value),
        },
        option.label,
        option.badge === undefined
          ? null
          : React.createElement('span', { className: 'sc-count' }, String(option.badge)),
      ),
    ),
  )
}

export function Section(props: {
  title: string
  right?: ReactNode
  children?: ReactNode
}): React.ReactElement {
  return React.createElement(
    'div',
    { className: 'sc-sec' },
    React.createElement(
      'div',
      { className: 'sc-sec-head' },
      React.createElement('span', { className: 'sc-sec-title' }, props.title),
      React.createElement('span', { className: 'sc-spacer' }),
      props.right ?? null,
    ),
    React.createElement('div', { className: 'sc-sec-body' }, props.children),
  )
}

export function Banner(props: { tone: 'err' | 'warn' | 'ok' | 'info'; text: string; right?: ReactNode }): React.ReactElement {
  return React.createElement(
    'div',
    { className: 'sc-banner', 'data-tone': props.tone },
    React.createElement('span', { className: 'sc-banner-text' }, props.text),
    props.right ?? null,
  )
}

export function Empty(props: { text: string; children?: ReactNode }): React.ReactElement {
  return React.createElement(
    'div',
    { className: 'sc-empty' },
    React.createElement('div', null, props.text),
    props.children === undefined ? null : React.createElement('div', { style: { marginTop: 8 } }, props.children),
  )
}

/**
 * 元信息横排：一行小卡，自动换行。
 * 比 `data-cols=2` 的网格在窄面板里稳定得多（网格会留下大片空白并把值挤到右侧）。
 */
export function MetaRow(props: { items: Array<{ k: string; v: ReactNode }> }): React.ReactElement {
  return React.createElement(
    'div',
    { className: 'sc-meta' },
    ...props.items.map((item, index) =>
      React.createElement(
        'span',
        { key: `${item.k}-${index}`, className: 'sc-meta-item' },
        React.createElement('span', { className: 'sc-meta-k' }, item.k),
        React.createElement('span', { className: 'sc-meta-v' }, item.v),
      ),
    ),
  )
}

/** 只读的数值/文本展示格。 */
export function Kv(props: { k: string; v: ReactNode }): React.ReactElement {
  return React.createElement(
    'div',
    { className: 'sc-kv' },
    React.createElement('span', { className: 'sc-k' }, props.k),
    React.createElement('span', { className: 'sc-v' }, props.v),
  )
}

// ── markdown 渲染 ──────────────────────────────────────────────────────────

interface MdBlock {
  kind: 'h' | 'p' | 'ul' | 'ol' | 'quote' | 'code' | 'hr' | 'table'
  level?: number
  text?: string
  items?: string[]
  rows?: string[][]
  header?: string[]
}

/** 把 markdown 切成块（确定性、无依赖）。 */
export function parseMarkdown(source: string): MdBlock[] {
  const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n')
  const blocks: MdBlock[] = []
  let paragraph: string[] = []
  let fence: string[] | null = null

  const flushParagraph = (): void => {
    if (paragraph.length > 0) {
      blocks.push({ kind: 'p', text: paragraph.join('\n') })
      paragraph = []
    }
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    if (fence !== null) {
      if (/^\s*```/.test(line)) {
        blocks.push({ kind: 'code', text: fence.join('\n') })
        fence = null
      } else {
        fence.push(line)
      }
      continue
    }
    if (/^\s*```/.test(line)) {
      flushParagraph()
      fence = []
      continue
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushParagraph()
      blocks.push({ kind: 'hr' })
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading !== null) {
      flushParagraph()
      blocks.push({ kind: 'h', level: (heading[1] ?? '#').length, text: heading[2] ?? '' })
      continue
    }
    if (/^\s*>\s?/.test(line)) {
      flushParagraph()
      const quote: string[] = []
      let j = i
      while (j < lines.length && /^\s*>\s?/.test(lines[j] ?? '')) {
        quote.push((lines[j] ?? '').replace(/^\s*>\s?/, ''))
        j += 1
      }
      i = j - 1
      blocks.push({ kind: 'quote', text: quote.join('\n') })
      continue
    }
    const isTable = /^\s*\|.*\|\s*$/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? '')
    if (isTable) {
      flushParagraph()
      const splitRow = (row: string): string[] =>
        row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim())
      const header = splitRow(line)
      const rows: string[][] = []
      let j = i + 2
      while (j < lines.length && /^\s*\|.*\|\s*$/.test(lines[j] ?? '')) {
        rows.push(splitRow(lines[j] ?? ''))
        j += 1
      }
      i = j - 1
      blocks.push({ kind: 'table', header, rows })
      continue
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      flushParagraph()
      const ordered = /^\s*\d+[.)]\s+/.test(line)
      const items: string[] = []
      let j = i
      while (j < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[j] ?? '')) {
        items.push((lines[j] ?? '').replace(/^\s*([-*+]|\d+[.)])\s+/, ''))
        j += 1
        // 续行（缩进）并入上一条
        while (j < lines.length && /^\s{2,}\S/.test(lines[j] ?? '') && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[j] ?? '')) {
          items[items.length - 1] = `${items[items.length - 1] ?? ''} ${(lines[j] ?? '').trim()}`
          j += 1
        }
      }
      i = j - 1
      blocks.push({ kind: ordered ? 'ol' : 'ul', items })
      continue
    }
    if (line.trim() === '') {
      flushParagraph()
      continue
    }
    paragraph.push(line)
  }
  flushParagraph()
  if (fence !== null && fence.length > 0) blocks.push({ kind: 'code', text: fence.join('\n') })
  return blocks
}

/** 行内标记：`code`、**粗**、*斜*。 */
function inline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = []
  // 不用 lookbehind：Safari < 16.4 会在**解析期**抛 SyntaxError 使整个 bundle 失效
  // （esbuild 只按 target 转换语法，不降级正则字面量）。
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\n]+\*)/g
  let last = 0
  let match = pattern.exec(text)
  let index = 0
  while (match !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index))
    const token = match[0]
    const key = `${keyPrefix}-i${index}`
    if (token.startsWith('`')) nodes.push(React.createElement('code', { key }, token.slice(1, -1)))
    else if (token.startsWith('**')) nodes.push(React.createElement('strong', { key }, token.slice(2, -2)))
    else nodes.push(React.createElement('em', { key }, token.slice(1, -1)))
    last = match.index + token.length
    index += 1
    match = pattern.exec(text)
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

/** markdown → React 元素。 */
export function Markdown(props: { text: string; className?: string }): React.ReactElement {
  // 规则书正文可达 24 万字符，而 snapshot 每 8 秒轮询一次：不缓存会反复重解析整篇。
  const blocks = React.useMemo(() => parseMarkdown(props.text), [props.text])
  return React.createElement(
    'div',
    { className: `sc-md ${props.className ?? ''}` },
    ...blocks.map((block, index) => {
      const key = `b${index}`
      if (block.kind === 'hr') return React.createElement('hr', { key })
      if (block.kind === 'h') {
        const tag = `h${Math.min(6, Math.max(1, block.level ?? 2))}`
        return React.createElement(tag, { key }, inline(block.text ?? '', key))
      }
      if (block.kind === 'code') {
        return React.createElement('pre', { key }, React.createElement('code', null, block.text ?? ''))
      }
      if (block.kind === 'quote') {
        return React.createElement(
          'blockquote',
          { key },
          ...(block.text ?? '').split('\n').map((line, i) => React.createElement('div', { key: `${key}-${i}` }, inline(line, `${key}-${i}`))),
        )
      }
      if (block.kind === 'ul' || block.kind === 'ol') {
        const tag = block.kind
        return React.createElement(
          tag,
          { key },
          ...(block.items ?? []).map((item, i) => React.createElement('li', { key: `${key}-${i}` }, inline(item, `${key}-${i}`))),
        )
      }
      if (block.kind === 'table') {
        return React.createElement(
          'table',
          { key },
          React.createElement(
            'thead',
            null,
            React.createElement(
              'tr',
              null,
              ...(block.header ?? []).map((cell, i) => React.createElement('th', { key: `${key}-h${i}` }, inline(cell, `${key}-h${i}`))),
            ),
          ),
          React.createElement(
            'tbody',
            null,
            ...(block.rows ?? []).map((row, r) =>
              React.createElement(
                'tr',
                { key: `${key}-r${r}` },
                ...row.map((cell, c) => React.createElement('td', { key: `${key}-r${r}c${c}` }, inline(cell, `${key}-r${r}c${c}`))),
              ),
            ),
          ),
        )
      }
      return React.createElement(
        'p',
        { key },
        ...(block.text ?? '').split('\n').map((line, i) =>
          React.createElement(React.Fragment, { key: `${key}-${i}` }, inline(line, `${key}-${i}`), i === 0 ? null : React.createElement('br')),
        ),
      )
    }),
  )
}

/** 相对时间（中文，简短）。 */
export function relTime(ts: number): string {
  if (!Number.isFinite(ts)) return '—'
  const delta = Date.now() - ts
  if (delta < 0) return '刚刚'
  const sec = Math.floor(delta / 1000)
  if (sec < 45) return '刚刚'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min} 分钟前`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时前`
  const day = Math.floor(hour / 24)
  if (day < 30) return `${day} 天前`
  return new Date(ts).toLocaleDateString('zh-CN')
}

/** 数字格式化（千分位）。 */
export function num(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—'
  return value.toLocaleString('en-US')
}
