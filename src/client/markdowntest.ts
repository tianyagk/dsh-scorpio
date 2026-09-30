/**
 * 客户端 markdown 解析器自测：`node src/client/markdowntest.ts`（Node 24 原生跑 TS，无需构建）。
 *
 * 为什么单独有它：src/client/ 其余模块都 import react，而本包 node_modules 里没有 react
 * 运行时，node 直接加载不了。解析器抽到 ./markdown.ts（不 import react）之后，这一层
 * 就能像 src/host/selftest.ts 一样被 node 原生跑起来。
 *
 * 断言口径：**以当前实现的实际行为为准**。凡是"看起来应该另外那样"的地方，都在断言旁用
 * 「当前行为」注明并保持解析器不动 —— 要改行为是一个单独的决定，不该由测试顺手改掉。
 *
 * 覆盖：标题层级 / 段落与软换行 / 列表（三种无序标记、两种有序写法、缩进续行）/ 引用块 /
 *      围栏代码块（含未闭合）/ 表格 / 分隔线三写法 / 行内标记原样保留 / 空输入与容错 /
 *      一段真实规则书片段的块类型序列。
 * 不覆盖：行内标记的**切分**（`code` → <code> 等）在 ui.tsx 的 inline()，依赖
 *      React.createElement，属于表现层；本文件只锁到 markdown.ts 导出的纯函数为止。
 */
import { parseMarkdown, type MdBlock } from './markdown.ts'

let passed = 0
let failed = 0
const failures: string[] = []
const ok = (condition: boolean, label: string, detail?: unknown): void => {
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
/** 结构比较：块列表、块类型序列、单元格这类断言用得上。 */
const eqJson = (actual: unknown, expected: unknown, label: string): void =>
  ok(JSON.stringify(actual) === JSON.stringify(expected), label, { actual, expected })
const section = (title: string): void => console.log(`\n── ${title} ──`)
/** 只取块类型（标题带上层级），用来断言"这段文本被切成了什么序列"。 */
const kinds = (blocks: MdBlock[]): string[] =>
  blocks.map((block) => (block.kind === 'h' ? `h${block.level ?? 0}` : block.kind))

// ── 标题 ───────────────────────────────────────────────────────────────────
section('标题：# ~ ###### 的层级与文本')
const heads = parseMarkdown('# 一\n## 二\n### 三\n#### 四\n##### 五\n###### 六\n')
eq(heads.length, 6, '六级标题各自成块，不互相粘连')
ok(heads.every((block) => block.kind === 'h'), '块类型统一是 h')
eqJson(heads.map((block) => block.level), [1, 2, 3, 4, 5, 6], '层级 1~6 逐级')
eq(heads[0]?.text, '一', '文本 = # 之后的正文（标记与一个空格被去掉）')
eq(heads[5]?.text, '六', '六级标题文本同样正确')
eqJson(kinds(parseMarkdown('####### 七\n')), ['p'], '七个 # 不是标题 —— 当前行为：退回普通段落')
eqJson(kinds(parseMarkdown('#无空格\n')), ['p'], '# 后缺空格不是标题 —— 当前行为：退回普通段落')
eqJson(kinds(parseMarkdown('  ## 缩进标题\n')), ['h2'], '缩进标题也识别（列表/引用/分隔线本来就允许缩进）')
eq(parseMarkdown('  ## 缩进标题\n')[0]?.text, '缩进标题', '缩进标题的文本正确')

// ── 段落 ───────────────────────────────────────────────────────────────────
section('段落与多行段落（软换行）')
const paras = parseMarkdown('第一行\n第二行\n\n第三段\n')
eq(paras.length, 2, '空行切段：得到两段')
eq(paras[0]?.kind, 'p', '第一块是段落')
eq(paras[0]?.text, '第一行\n第二行', '块内软换行以 \\n 保留（渲染层再拆行）')
eq(paras[1]?.text, '第三段', '第二段文本')
eq(parseMarkdown('甲\n')[0]?.text, '甲', '文末换行不产生空段落')
eq(parseMarkdown('  甲  \n')[0]?.text, '  甲  ', '段落不 trim —— 当前行为：缩进与尾空格原样进文本')
eqJson(kinds(parseMarkdown('甲\n- a\n')), ['p', 'ul'], '段落紧跟列表：段落先落块，不被列表吞掉')

// ── 列表 ───────────────────────────────────────────────────────────────────
section('列表：- * + / 1. 2) / 缩进续行')
const ul = parseMarkdown('- 甲\n* 乙\n+ 丙\n')
eq(ul.length, 1, '三种无序标记合成同一个列表块（中间没有空行）')
eq(ul[0]?.kind, 'ul', '块类型 ul')
eqJson(ul[0]?.items, ['甲', '乙', '丙'], '三种标记都只去掉标记与一个空格')
const ol = parseMarkdown('1. 甲\n2) 乙\n3. 丙\n')
eq(ol[0]?.kind, 'ol', '1. 与 2) 都算有序标记')
eqJson(ol[0]?.items, ['甲', '乙', '丙'], '有序列表条目文本')
eq(parseMarkdown('1. 甲\n- 乙\n')[0]?.kind, 'ol', '首行有序 → 整块 ol —— 当前行为：混排不拆块')
eq(parseMarkdown('- 甲\n1. 乙\n')[0]?.kind, 'ul', '首行无序 → 整块 ul —— 当前行为：同上')
const cont = parseMarkdown('- 甲\n  续行一\n    续行二\n- 乙\n')
eqJson(cont[0]?.items, ['甲 续行一 续行二', '乙'], '缩进续行并入上一条（单空格连接、行首尾空白被 trim）')
eqJson(parseMarkdown('- 甲\n  续\n')[0]?.items, ['甲 续'], '末条之后的续行同样并入（列表在文末结束）')
eqJson(kinds(parseMarkdown('- 甲\n 续\n')), ['ul', 'p'], '只缩进 1 格不算续行 —— 当前行为：列表结束，该行成为段落')
eqJson(kinds(parseMarkdown('- 甲\n\n  续\n')), ['ul', 'p'], '空行打断列表：缩进行不再并入 —— 当前行为')
eqJson(parseMarkdown('- 甲\n  - 子项\n- 乙\n')[0]?.items, ['甲', '子项', '乙'], '嵌套列表被拍平为同级项 —— 当前行为：块内没有层级信息')

// ── 引用 ───────────────────────────────────────────────────────────────────
section('引用块：> 多行合并')
const quotes = parseMarkdown('> 甲\n> 乙\n\n> 丙\n')
eq(quotes.length, 2, '空行断开 → 两个引用块')
eq(quotes[0]?.kind, 'quote', '块类型 quote')
eq(quotes[0]?.text, '甲\n乙', '相邻 > 行合并进同一块（\\n 连接）')
eq(parseMarkdown('>无空格\n')[0]?.text, '无空格', '> 后无空格也识别')
eq(parseMarkdown('>   三个空格\n')[0]?.text, '  三个空格', '> 只吃掉一个空格 —— 当前行为：其余空格留在正文里')
const quoteBlank = parseMarkdown('> 甲\n> 乙\n> \n> 丙\n')
eq(quoteBlank.length, 1, '块内空引用行不断块')
eq(quoteBlank[0]?.text, '甲\n乙\n\n丙', '空引用行 → 空行（渲染层按行拆开）')
eqJson(kinds(parseMarkdown('> # 标题\n')), ['quote'], '引用内部不做二次块解析 —— 当前行为：# 只是一段文本')
eq(parseMarkdown('> **粗**与`代码`\n')[0]?.text, '**粗**与`代码`', '引用正文里的行内标记原样保留')

// ── 代码围栏 ───────────────────────────────────────────────────────────────
section('围栏代码块：内部原样 / 未闭合围栏')
const fenced = parseMarkdown('```\n# 不是标题\n- 不是列表\n> 不是引用\n| a | b |\n```\n')
eq(fenced.length, 1, '围栏内全部内容合成一个 code 块')
eq(fenced[0]?.kind, 'code', '块类型 code')
eq(fenced[0]?.text, '# 不是标题\n- 不是列表\n> 不是引用\n| a | b |', '内部原样保留：# / - / > / | 都不触发块解析')
const info = parseMarkdown('```ts\ncode\n```\n')
eqJson(kinds(info), ['code'], '围栏后可跟语言标注')
eq(info[0]?.text, 'code', '语言标注不进正文 —— 当前行为：info string 被丢弃')
eq(parseMarkdown('```\n\n# 头\n\n```\n')[0]?.text, '\n# 头\n', '围栏内的空行同样原样保留')
eqJson(kinds(parseMarkdown('正文\n\n```\n甲\n```\n尾部\n')), ['p', 'code', 'p'], '围栏前后的块顺序正确')
// 未闭合围栏：照实断言当前行为（围栏一直吃到文末；文末换行会留下一个尾空行）
const open = parseMarkdown('```\n甲\n乙\n')
eqJson(kinds(open), ['code'], '未闭合围栏：到文末仍是 code 块')
eq(open[0]?.text, '甲\n乙\n', '未闭合围栏：正文含文末换行带来的尾空行（当前行为）')
const swallows = parseMarkdown('正文\n\n```\n甲\n## 后面的标题\n')
eqJson(kinds(swallows), ['p', 'code'], '未闭合围栏吃掉其后全部内容 —— 当前行为：## 标题也进了 code')
eq(swallows[1]?.text, '甲\n## 后面的标题\n', '被吃掉的内容原样留在 code 正文里')
eq(parseMarkdown('```\n')[0]?.text, '', '未闭合且无内容（文末有换行）：code 正文为空串')
eqJson(kinds(parseMarkdown('```')), [], '文末孤零零一个 ``` ：整块消失 —— 当前行为（fence 长度 0 时不落块）')

// ── 表格 ───────────────────────────────────────────────────────────────────
section('表格：表头 + 分隔行 + 多行数据')
const table = parseMarkdown('| 属性 | 值 |\n| --- | --- |\n| 理智 | 60 |\n| 健康 | 55 |\n')
eq(table.length, 1, '整张表一个块')
eq(table[0]?.kind, 'table', '块类型 table')
eqJson(table[0]?.header, ['属性', '值'], '表头单元格已 trim（| 两侧空格去掉）')
eqJson(table[0]?.rows, [['理智', '60'], ['健康', '55']], '两行数据，单元格同样 trim')
eqJson(parseMarkdown('| a | b |\n| --- | --- |\n')[0]?.rows, [], '只有表头没有数据行 → rows 为空数组')
eqJson(parseMarkdown('  | a | b |  \n| :-: | --- |\n| 1 | 2 |\n')[0]?.header, ['a', 'b'], '前后带空格的表头行也识别')
eqJson(parseMarkdown('| a | b | c |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n| 4 |\n')[0]?.rows, [['1', '2', '3'], ['4']], '列数不齐不补齐 —— 当前行为：有几格给几格')
eqJson(kinds(parseMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |\n尾巴\n')), ['table', 'p'], '数据行结束（无 | 收尾）后回到段落')
// 表头行**尾管道可选**：手写规则书很容易漏收尾，漏一个就整表降级成段落、
// 把 `| --- |` 分隔行原样显示给玩家（这是修掉的行为）。行首的 `|` 才是表格标记。
const noTail = parseMarkdown('| a | b\n| --- | --- |\n| 1 | 2 |\n')
eqJson(kinds(noTail), ['table'], '表头行缺尾部 | 仍识别为表格')
eqJson(noTail[0]?.header, ['a', 'b'], '缺尾管道时表头单元格正确切分')
eqJson(noTail[0]?.rows, [['1', '2']], '缺尾管道时数据行正确切分')

// ── 分隔线 ─────────────────────────────────────────────────────────────────
section('分隔线：--- / *** / ___')
eqJson(kinds(parseMarkdown('---\n***\n___\n')), ['hr', 'hr', 'hr'], '三种写法都识别为 hr')
eqJson(kinds(parseMarkdown('  ----  \n')), ['hr'], '前后空格与更长的横线同样识别')
eqJson(kinds(parseMarkdown('甲\n---\n乙\n')), ['p', 'hr', 'p'], '夹在段落之间：段落被切断，没有吞行')
eqJson(kinds(parseMarkdown('--\n')), ['p'], '只有 2 个 - 不是分隔线 —— 当前行为：退回段落')
eqJson(kinds(parseMarkdown('*斜体* 不是分隔线\n')), ['p'], '行内星号不误判成分隔线')

// ── 行内标记 ───────────────────────────────────────────────────────────────
section('行内标记：解析层只负责原样保留')
// 切分（`code` → <code>、**粗** → <strong>、*斜* → <em>）在 ui.tsx 的 inline() 里，依赖
// React.createElement，不在 markdown.ts 的导出面上 —— 这里只锁"标记原样进文本"这个前提。
eq(
  parseMarkdown('他说 **很重要**，看 `代码` 与 *斜体*。\n')[0]?.text,
  '他说 **很重要**，看 `代码` 与 *斜体*。',
  '段落里的行内标记原样保留（含中文标点）',
)
eqJson(parseMarkdown('- **加粗**项\n- `代码`项\n')[0]?.items, ['**加粗**项', '`代码`项'], '列表条目里的行内标记原样保留')
eq(parseMarkdown('## **加粗** 标题\n')[0]?.text, '**加粗** 标题', '标题里的行内标记原样保留')
const codeLine = parseMarkdown('`代码`\n')
eqJson(kinds(codeLine), ['p'], '整行只有行内代码 → 仍是段落，不是代码块')
eq(codeLine[0]?.text, '`代码`', '反引号原样保留，没有被剥掉')
eq(parseMarkdown('`代码`单独一行\n')[0]?.text, '`代码`单独一行', '行内代码与后续文字同行时整体进文本（当前行为：不做行内切分）')

// ── 空输入与容错 ───────────────────────────────────────────────────────────
section('空输入与容错')
eqJson(parseMarkdown(''), [], '空字符串 → 空数组')
eqJson(parseMarkdown('\n\n\n'), [], '只有换行 → 空数组')
eqJson(parseMarkdown('   \n\t\n  \n'), [], '纯空白（空格/制表符）→ 空数组')
const safe = (source: unknown): MdBlock[] | null => {
  try {
    return parseMarkdown(source as string)
  } catch {
    return null
  }
}
eqJson(safe(''), [], '空输入不抛异常')
eqJson(safe('   '), [], '纯空白输入不抛异常')
eqJson(safe(undefined), [], 'undefined 不抛 —— 当前行为：String(source ?? \'\') 兜底成空串')
eqJson(safe(42), [{ kind: 'p', text: '42' }], '非字符串入参被 String() 化 —— 当前行为：42 变成段落')
eqJson(kinds(parseMarkdown('甲\r\n乙\r\n\r\n丙\r\n')), ['p', 'p'], 'CRLF 归一化后再切块')
eq(parseMarkdown('甲\r\n乙\r\n')[0]?.text, '甲\n乙', 'CRLF 归一化成 \\n（软换行里不留 \\r）')

// ── 真实规则书片段 ─────────────────────────────────────────────────────────
section('真实规则书片段：块类型序列')
const rulebook = [
  '# 密教模拟器 · 判定速查',
  '',
  '以下规则来自本世界的**核心**设定，`单骰低位` 为准。',
  '',
  '| 难度 | 修正 |',
  '| --- | --- |',
  '| 棘手 | -20 |',
  '| 显而易见 | +40 |',
  '',
  '> 有失败可能就掷骰。',
  '',
  '```d100',
  '1d100 ≤ 目标值',
  '```',
  '',
  '- 属性：理智 / 健康 / 激情',
  '- 技能：研习、潜行',
  '',
  '---',
  '',
].join('\n')
const book = parseMarkdown(rulebook)
eqJson(kinds(book), ['h1', 'p', 'table', 'quote', 'code', 'ul', 'hr'], '块类型序列：标题→段落→表格→引用→代码→列表→分隔线')
eq(book.length, 7, '一共 7 个块，没有多出来的空段落')
eq(book[0]?.text, '密教模拟器 · 判定速查', '标题文本完整')
eqJson(book[2]?.rows, [['棘手', '-20'], ['显而易见', '+40']], '表格数据两行（分隔行本身不成块）')
eq(book[4]?.text, '1d100 ≤ 目标值', '代码块正文保留不等号等原样字符')
eqJson(book[5]?.items, ['属性：理智 / 健康 / 激情', '技能：研习、潜行'], '列表两条，内部 / 与顿号原样')

// ── 产出 ───────────────────────────────────────────────────────────────────
console.log(`\n${failed === 0 ? '✅' : '❌'} 通过 ${passed} 项 / 失败 ${failed} 项`)
if (failed > 0) {
  for (const item of failures) console.log(`  · ${item}`)
  process.exitCode = 1
}
