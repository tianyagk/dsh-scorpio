/**
 * markdown 纯解析层：把规则书正文切成块。
 *
 * 刻意不 import react：解析本身是纯函数，单独放一层就能被 node 直接加载做自测
 * （`node src/client/markdowntest.ts`）。React 渲染仍是 ./ui.tsx 里 `Markdown` 的事，
 * 本文件不产出任何 React 元素、不碰 DOM。
 */

/** 一个块。`level` 只用于标题，`text` 用于段落/引用/代码块，`items` 用于列表，`header`/`rows` 用于表格。 */
export interface MdBlock {
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
    const heading = /^\s*(#{1,6})\s+(.*)$/.exec(line)
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
    // 表格标记：行以 `|` 开头即可，**尾管道可选**——手写规则书的表格很容易漏收尾，
    // 旧实现要求首尾都有 `|`，漏一个就把整张表降级成段落、把 `| --- |` 分隔行原样显示给玩家。
    const looksLikeRow = (text: string): boolean => /^\s*\|/.test(text)
    const isTable = looksLikeRow(line) && /^\s*\|[\s:|-]*-[\s:|-]*\|?\s*$/.test(lines[i + 1] ?? '')
    if (isTable) {
      flushParagraph()
      const splitRow = (row: string): string[] =>
        row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim())
      const header = splitRow(line)
      const rows: string[][] = []
      let j = i + 2
      while (j < lines.length && looksLikeRow(lines[j] ?? '')) {
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
