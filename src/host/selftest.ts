/**
 * 自测：`node src/host/selftest.ts`（Node 24 原生跑 TS，无需构建）。
 *
 * 覆盖 v0.2 的三条主线 + 判定：
 *   · 世界书：扫描、文本过滤、路径围栏
 *   · 规则书：同一世界多套（d100 / d20 / d6 骰池）、schema 校验、角色卡按 schema 重建
 *   · 模组集：写入、读取、按世界分组
 *   · 角色卡：角色池 → 导入会话实例 → 增量补丁
 *   · 四元组：绑定、换世界时清理、还缺哪几环
 *   · 判定：三种系统的目标值语义 + 骰池成功数 + 大成功/失败 + 对抗 + 流水
 */
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeSchema, parseDice, performRoll } from './dice.ts'
import { ScorpioStore, reconcileBody } from './store.ts'
import { PathFenceError, scanWorldbook } from './worldbook.ts'
import type { RulesSchema } from '../shared/model.ts'

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
const section = (title: string): void => console.log(`\n── ${title} ──`)

// ── 骰式与三种系统的目标值语义 ──────────────────────────────────────────────
section('判定引擎（三种系统）')
eq(parseDice('1d20+5').normalized, '1d20+5', 'd20 带加值')
eq(parseDice('6d6').times, 6, 'd6 骰池六枚')
const fix = (values: number[]): (() => number) => {
  let i = 0
  return () => values[Math.min(i++, values.length - 1)] ?? 0
}

const d100 = normalizeSchema({
  system: 'd100 低位', baseDice: '1d100', direction: 'rollUnder', defaultDifficulty: 0,
  difficultyLadder: [{ label: '棘手', value: -20 }, { label: '普通', value: 0 }],
  attributes: [{ id: 'reason', label: '理智' }], skills: [{ id: 'study', label: '研习', attribute: 'reason' }],
})
const body = { name: '测试者', attrs: [{ id: 'reason', value: 60 }], skills: [{ id: 'study', value: 20 }], slots: [], statuses: [], journal: [], initialized: false }
const r1 = performRoll({ check: 'study' }, { rng: () => 0, schema: d100, sheet: body })
eq(r1.roll.target, 80, 'd100：未给难度 → 属性+技能（60+20）')
const r2 = performRoll({ check: 'study', difficulty: -20 }, { rng: () => 0, schema: d100, sheet: body })
eq(r2.roll.target, 60, 'd100：难度 -20（棘手）→ 目标 60')
eq(r2.difficultyLabel, '棘手', '难度档标签按难度值匹配')

const d20 = normalizeSchema({
  system: 'd20 高骰', baseDice: '1d20+5', direction: 'rollOver', defaultDifficulty: 12,
  attributes: [{ id: 'lv', label: '等级' }], skills: [{ id: 'attack', label: '攻击' }],
})
const r3 = performRoll({ check: 'attack', modifier: 3 }, { rng: () => 0.5, schema: d20, sheet: body })
eq(r3.roll.spec.modifier, 5, 'd20：骰式自带的 +5 生效')
eq(r3.roll.target, 9, 'd20：rollOver 目标 = defaultDifficulty 12 − 临时修正 3')
eq(r3.roll.total, 16, 'd20：骰面 11 + 骰式加值 5 = 16')
eq(r3.success, true, 'd20：16 ≥ 9 → 成功')

const d6 = normalizeSchema({
  system: 'd6 骰池', baseDice: '5d6', direction: 'rollOver', defaultDifficulty: 2,
  poolTarget: 5, attributes: [{ id: 'body', label: '体魄' }], skills: [{ id: 'lift', label: '举重' }],
})
const r4 = performRoll({ check: 'lift' }, { rng: fix([0.9, 0.9, 0.2, 0.1, 0.0]), schema: d6 })
eq(r4.roll.successes, 2, 'd6 骰池：骰面 6/6/2/1/1 中 2 枚 ≥5 → 成功数 2')
eq(r4.roll.total, 2, 'd6 骰池：比较成功数而非点数和')
eq(r4.success, true, 'd6 骰池：成功数 2 ≥ 难度 2 → 成功')

const crit = performRoll({ expression: '1d100' }, { rng: () => 0, schema: normalizeSchema({ system: 'x', baseDice: '1d100', direction: 'rollUnder', critSuccess: { max: 5 } }) })
eq(crit.outcome, 'critical-success', '骰面 1 → 大成功')
const oppSchema = normalizeSchema({
  system: '对抗用 d100', baseDice: '1d100', direction: 'rollUnder', defaultDifficulty: 0,
  attributes: [{ id: 'dex', label: '敏捷' }], skills: [{ id: 'dodge', label: '闪避', attribute: 'dex' }],
})
const oppSheet = (dex: number) => ({
  name: 'T', attrs: [{ id: 'dex', value: dex }], skills: [{ id: 'dodge', value: 0 }],
  slots: [], statuses: [], journal: [], initialized: false,
})
const opp = performRoll(
  { expression: '1d100', opposed: { name: '守卫', value: 80 } },
  { rng: fix([0.99]), schema: normalizeSchema({ system: 'x', baseDice: '1d100', direction: 'rollUnder' }) },
)
eq(opp.opposed?.target, 80, '对抗：对手可指定自己的目标值（技能值）')
// 双方各掷一次（同骰 100），比"相对各自目标的余量"：
// 玩家目标 50 → 余量 -50；守卫目标 80 → 余量 -20 → 玩家落败。
// （旧实现比较裸骰值，100 > 80 会判成"胜出"——那正是被修掉的语义错误。）
eq(opp.outcome, 'failure', 'rollUnder 对抗按余量比较：同骰下目标低者落败')

// 属性/技能必须参与对抗：同样的骰值，属性高的一方余量大 → 结果不同
const oppWeak = performRoll({ check: 'dodge', opposed: { name: '对手', value: 30 } }, { rng: () => 0.5, schema: oppSchema, sheet: oppSheet(0) })
const oppStrong = performRoll({ check: 'dodge', opposed: { name: '对手', value: 30 } }, { rng: () => 0.5, schema: oppSchema, sheet: oppSheet(90) })
ok(
  oppWeak.outcome !== oppStrong.outcome,
  '属性参与对抗（旧实现对 dex=0 与 dex=90 给出完全相同的结果）',
  { weak: oppWeak.outcome, strong: oppStrong.outcome },
)

// ── 世界书 ─────────────────────────────────────────────────────────────────
section('世界书')
const root = await mkdtemp(join(tmpdir(), 'scorpio-v2-'))
const ws = join(root, 'ws')
const dir = join(ws, 'corpus')
await mkdir(join(dir, 'lore'), { recursive: true })
await mkdir(join(dir, 'node_modules'), { recursive: true })
await writeFile(join(dir, '密教世界书.md'), '# 密教\n\n1926 年伦敦。\n', 'utf8')
await writeFile(join(dir, 'lore', '势力.md'), '## 镇压局\n', 'utf8')
await writeFile(join(dir, 'cover.png'), Buffer.from([0x89, 0x50, 0x00]))
await writeFile(join(dir, 'node_modules', 'skip.md'), '不该读到\n', 'utf8')

const scanned = await scanWorldbook(ws, 'corpus')
eq(scanned.files.length, 2, '只收 md、跳过 node_modules 与 png')
let fenced = false
try {
  await scanWorldbook(ws, '../')
} catch (error) {
  fenced = error instanceof PathFenceError
}
ok(fenced, '越界路径被拒绝')

// ── 三条主线 ───────────────────────────────────────────────────────────────
section('世界书 → 规则书（多套）→ 模组 → 角色卡 → 四元组')
const store = new ScorpioStore(ws)
const sid = 'session-v2-test'
const world = await store.upsertWorld({
  id: '密教', name: '密教', path: 'corpus', loadedAt: Date.now(),
  fileCount: scanned.files.length, totalChars: scanned.totalChars,
  files: scanned.files.map(({ rel, chars, truncated }) => ({ rel, chars, truncated })),
})
eq(world.id, '密教', '世界书写入')
await store.bindRun(sid, { worldId: world.id })

const schemaA: RulesSchema = {
  version: 1, system: '密教 d100', baseDice: '1d100', direction: 'rollUnder', defaultDifficulty: 0,
  difficultyLadder: [{ label: '普通', value: 0 }, { label: '棘手', value: -20 }],
  attributes: [{ id: 'reason', label: '理智', group: '三支柱', base: 60 }, { id: 'health', label: '健康', group: '三支柱' }],
  skills: [{ id: 'study', label: '研习', attribute: 'reason' }],
  statusSystem: '着迷/恐惧', adjudication: '有失败可能就掷骰',
}
const ruleA = await store.writeRulebook({
  worldId: world.id, title: '密教模拟器规则书', style: 'd100', pitch: '细颗粒度、偏扮演',
  mdRel: '密教模拟器规则书.md', markdown: '# 密教规则\n', schema: schemaA, editedBy: 'agent',
})
eq(ruleA.id, '密教模拟器', '规则书 id 由标题派生')
const ruleB = await store.writeRulebook({
  worldId: world.id, title: '密教快打规则书', style: 'd20',
  mdRel: '密教快打规则书.md', markdown: '# 快打\n',
  schema: { ...schemaA, system: '密教 d20', baseDice: '1d20+5', direction: 'rollOver', defaultDifficulty: 12 },
  editedBy: 'agent',
})
const rules = await store.rulesOf(world.id)
eq(rules.length, 2, '同一世界可存两套规则书')
ok(rules.some((r) => r.style === 'd100') && rules.some((r) => r.style === 'd20'), '两套风格不同')
eq((await store.rulebook(world.id, ruleB.id))?.schema.baseDice, '1d20+5', '按 id 取第二套')
const mdOnDisk = await readFile(join(ws, '密教模拟器规则书.md'), 'utf8')
ok(mdOnDisk.includes('密教规则'), '规则书正文写进工作区可见路径')

const module = await store.writeModule({
  worldId: world.id, name: '一封来自死者的信', tagline: '顾知白的遗信把你叫到查令十字街 74 号。',
  mdRel: 'modules/一封来自死者的信.md', markdown: '# 开场\n\n雾、煤气灯、三楼房门的抓痕。\n',
  scale: 'one-shot', tags: ['调查'], source: 'agent',
})
eq((await store.modulesOf(world.id)).length, 1, '模组写入模组集')
eq((await store.readModuleMarkdown(module)).missing, false, '模组正文可读回')

const template = await store.saveTemplate(
  {
    worldId: world.id, rulebookId: ruleA.id, moduleId: module.id, source: 'agent', generated: true,
    body: {
      name: '林奕', concept: '记者 · 启／变化',
      attrs: [{ id: 'reason', value: 55 }, { id: 'health', value: 60 }],
      skills: [{ id: 'study', value: 20 }],
      slots: [{ id: 'i1', name: '黄铜书签', kind: 'item', qty: 1 }],
      statuses: [], journal: [], initialized: false,
    },
  },
  ruleA,
)
eq(template.id, '林奕', '角色池：模板 id 由角色名派生')
eq((await store.pool(world.id)).length, 1, '角色池里有 1 张')

const instance = await store.importTemplate(sid, template, { rulebookId: ruleA.id, moduleId: module.id })
eq(instance.templateId, template.id, '导入后实例记住来自哪张模板')
eq(instance.worldId, world.id, '实例属于该世界')
const patched = await store.patchInstance(sid, world.id, {
  attrs: [{ id: 'reason', value: 66, pending: false }],
  entry: undefined,
} as never, 'agent', ruleA)
void patched
const after = await store.patchInstance(
  sid, world.id,
  { attrs: [{ id: 'reason', value: 66, pending: false }], slots: [{ id: 'i2', name: '手电', kind: 'item' }], statuses: [{ id: 's1', label: '着迷', remaining: 2 }], initialized: true },
  'agent', ruleA,
)
eq(after.attrs.find((a) => a.id === 'reason')?.value, 66, '实例属性按 id upsert')
eq(after.slots.length, 2, '实例槽位合并')
eq(after.statuses[0]?.remaining, 2, '实例状态写入')
eq(after.initialized, true, '实例初始化标记')

// schema 变更 → 角色卡条目重建
const rebuilt = reconcileBody(after, normalizeSchema({ ...schemaA, attributes: [{ id: 'reason', label: '理智', group: '三支柱' }], skills: [] }))
eq(rebuilt.body.attrs.length, 1, 'schema 收缩后属性表同步收缩')
eq(rebuilt.body.attrs[0]?.value, 66, '保留已有取值')
eq(rebuilt.body.skills.length, 0, '技能表同步收缩')

// 四元组
await store.bindRun(sid, { rulebookId: ruleB.id, moduleId: module.id })
const binding = await store.binding(sid)
eq(binding.rulebookId, ruleB.id, '四元组：切到第二套规则书')
await store.bindRun(sid, { worldId: '另一个世界' })
const afterSwitch = await store.binding(sid)
eq(afterSwitch.rulebookId, undefined, '换世界时清掉旧世界的规则书选择')
eq(afterSwitch.moduleId, undefined, '换世界时清掉旧世界的模组选择')

// ── 判定写流水 ─────────────────────────────────────────────────────────────
section('判定流水')
const roll = performRoll({ check: 'study', action: '在黑暗中摸索' }, { schema: ruleA.schema, sheet: after, rng: () => 0 })
await store.appendRoll(roll)
await store.appendRoll({ ...roll, id: `${roll.id}-b`, action: '第二次' })
const ledger = await store.diceLedger(10)
eq(ledger.total, 2, '流水两条')
eq(ledger.recent[0]?.action, '第二次', '倒序读取')

// ── 清理与产出 ─────────────────────────────────────────────────────────────
await rm(root, { recursive: true, force: true })
console.log(`\n${failed === 0 ? '✅' : '❌'} 自测结果：${passed} 通过 / ${failed} 失败`)
if (failed > 0) {
  for (const item of failures) console.log(`  · ${item}`)
  process.exitCode = 1
}
