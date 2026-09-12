/**
 * 预设回归自测：`node src/host/presettest.ts`。
 *
 * 用**宿主真实的 YAML 方言**（`!!js` → `{__jsExpr}`，见 dsh-app-boot）解析
 * preset/agent.cordis.yml，然后逐行核对：
 *   · 结构合法（顶层是行数组、id 唯一、group 带 isolate）；
 *   · 每个启用的行都能从 profile 或 dsh 安装解析到包（离线可查）；
 *   · `!!js` 表达式是本机可求值的布尔（disabled 行真的被禁用）；
 *   · preset.yml 有 name/description（否则 picker 只显示目录名）。
 *
 * 只读，不挂载预设、不启动会话。真正的挂载校验由 `standingKeyFor(id)` 提供，
 * 需要在装有该预设的 dsh 进程内进行。
 */
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const DSH_PKG = '/home/hu/.nvm/versions/node/v24.16.0/lib/node_modules/@deepseek-ai/dsh'
const PROFILE = process.env.SCORPIO_PROFILE ?? '/home/hu/.dsh/profiles/web'
const PRESET_DIR = process.env.SCORPIO_PRESET ?? join(process.env.DSH_HOME ?? `${process.env.HOME}/.dsh`, '.agent-presets/scorpio')
const REPO = new URL('../..', import.meta.url).pathname.replace(/\/$/, '')

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

const hostRequire = createRequire(`${DSH_PKG}/package.json`)
const yaml = hostRequire('js-yaml')
const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data: unknown) => typeof data === 'string',
  construct: (data: string) => ({ __jsExpr: data }),
  predicate: (data: unknown) => typeof data === 'object' && data !== null && '__jsExpr' in (data as object),
  represent: (data: { __jsExpr: string }) => data.__jsExpr,
})
const schema = yaml.JSON_SCHEMA.extend(JsExpr)

console.log('\n── 预设文件 ──')
const compositionPath = existsSync(join(PRESET_DIR, 'agent.cordis.yml'))
  ? join(PRESET_DIR, 'agent.cordis.yml')
  : join(REPO, 'preset', 'agent.cordis.yml')
ok(existsSync(compositionPath), `找到组合文件（${compositionPath}）`)

const rows = yaml.load(readFileSync(compositionPath, 'utf8'), { schema }) as Array<{
  id: string
  name?: string
  group?: boolean
  isolate?: Record<string, unknown>
  disabled?: unknown
  config?: unknown
}>

ok(Array.isArray(rows) && rows.length > 0, '顶层是插件行数组')
const ids = rows.map((row) => row.id)
ok(new Set(ids).size === ids.length, '行 id 唯一')
ok(ids.includes('scorpio'), '包含天蝎座插件行')

const scorpioRow = rows.find((row) => row.id === 'scorpio')
const scorpioName = scorpioRow?.name ?? ''
ok(
  scorpioName === 'dsh-scorpio' || scorpioName.startsWith('file:'),
  '天蝎座行指向 dsh-scorpio 包名或 file: 路径',
  scorpioName,
)
if (scorpioName.startsWith('file:')) {
  ok(existsSync(scorpioName.slice('file:'.length)), 'file: 路径实际存在')
}

const groups = rows.filter((row) => row.group === true)
ok(groups.length > 0, '包含 group 行')
ok(
  groups.every((group) => typeof group.isolate === 'object' && group.isolate !== null),
  '每个 group 都带 isolate realm',
)
ok(
  rows.filter((row) => row.name?.startsWith('cordis:') === true && row.group !== true).length === 0,
  'cordis: 行都是 group',
)

console.log('\n── 行解析 ──')
const profileRequire = createRequire(join(PROFILE, 'package.json'))
const resolves = (name: string): boolean => {
  if (name.startsWith('file:')) return existsSync(name.slice('file:'.length))
  if (name.startsWith('cordis:')) return true
  try {
    profileRequire.resolve(name)
    return true
  } catch {
    /* 继续尝试 dsh 安装 */
  }
  try {
    hostRequire.resolve(name)
    return true
  } catch {
    /* 解析不到 */
  }
  if (existsSync(join(REPO, 'node_modules', name))) return true
  return false
}

const disabledRows: string[] = []
const unresolved: string[] = []
for (const row of rows) {
  const name = row.name
  if (name === undefined || name === '' || name.startsWith('cordis:')) continue
  let disabled = false
  const raw = row.disabled
  if (typeof raw === 'boolean') disabled = raw
  else if (typeof raw === 'object' && raw !== null && '__jsExpr' in (raw as object)) {
    const expr = (raw as { __jsExpr: string }).__jsExpr
    try {
      // 只求值预设里出现的这几种平台判断；求值失败即视为启用（保守）。
      disabled = Boolean(new Function(`return (${expr});`)())
      void expr
    } catch {
      disabled = false
    }
  }
  if (disabled) {
    disabledRows.push(`${row.id} → ${name}`)
    continue
  }
  if (!resolves(name)) unresolved.push(`${row.id} → ${name}`)
}
ok(unresolved.length === 0, '所有启用行都能解析到包', unresolved)
console.log(`  · 本机禁用的行：${disabledRows.length === 0 ? '（无）' : disabledRows.join('、')}`)

console.log('\n── 元数据 ──')
const metaPath = join(compositionPath, '..', 'preset.yml')
ok(existsSync(metaPath), 'preset.yml 存在')
if (existsSync(metaPath)) {
  const meta = yaml.load(readFileSync(metaPath, 'utf8')) as { name?: string; description?: string }
  ok(typeof meta.name === 'string' && meta.name.trim() !== '', 'preset.yml 有 name')
  ok(typeof meta.description === 'string' && meta.description.trim() !== '', 'preset.yml 有 description')
}
const skillPath = join(compositionPath, '..', 'skills', 'trpg-gm', 'SKILL.md')
ok(existsSync(skillPath), '随预设分发的主持手法 skill 存在')

console.log(`\n${failed === 0 ? '✅' : '❌'} 预设回归：${passed} 通过 / ${failed} 失败`)
if (failed > 0) {
  for (const item of failures) console.log(`  · ${item}`)
  process.exitCode = 1
}
