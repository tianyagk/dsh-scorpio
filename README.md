# dsh-scorpio（天蝎座 Scorpio）

一个 DeepSeek Harness **Web 插件**：为实时推演的线上 TRPG（桌面角色扮演）提供一套完整的主持工具链，并把「天蝎座 Scorpio」注册为一个 **Agent 预设**。使用该预设的会话里，侧边栏会多出一个 🦂「天蝎座」页签，用来导入世界书、查看与编辑规则书、查看与编辑角色信息、掷骰与复盘判定流水。

> 与其他会话完全隔离：**只有跑在 Scorpio 预设上的会话**才拥有这些工具与这扇配置窗，别的预设既看不到页签、也调不到工具，宿主侧还会对非 Scorpio 会话直接返回 403。

## 功能

### 一、世界书（载入 / 查看 / 切换 / 移除）
- 载入**当前工作区内任意目录**的全部文本文件（`.md` `.txt` `.json` `.yaml` `.csv` 等，递归扫描，自动跳过 `node_modules`/`.git`/产物目录）；一个工作区可以存多本世界书并随时切换绑定。
- 扫描结果同时给两边：界面拿到清单（点文件名可展开预览），会话里的模型拿到全文（用于生成规则书）。
- 大目录可勾选「只登记清单」，避免把整库塞进上下文。

### 二、规则书（`{世界书名称}规则书.md`）
- 由 Agent 阅读世界观后撰写，经 `scorpio_rulebook_write` 落盘到工作区可读可改的 md 文件，同时在 `.scorpio/` 留一份副本。
- 与正文一起写入**机器可读 schema**：系统名、基础骰式、判定方向（低骰/高骰成功）、难度阶梯、大成功/大失败区间、属性表、技能表、状态系统、判定原则。
- 页签内可**就地编辑**正文与 schema 并保存；schema 一变，角色卡会自动按新属性/技能表重建（保留已有取值，新条目标为「待确认」）。

### 三、角色信息（规则书驱动，随规则书动态渲染）
- 分区：身份（角色名 / 概念）、**属性**（按 schema 分组渲染）、**技能**、**物品**、**队友**、**宠物**、**随从**、**状态**（带持续回合与增益/减益）、**经历与线索**、自由备注。
- 硬性顺序：**先载入世界书 → 生成规则书 → 由 Agent 依据世界观与规则书用问询（`ask_user_question`）逐项与玩家确认**，确认结果才写入角色卡；无默认值的属性一律带「待确认」标记，页签高亮提示，不替玩家拍板。
- 玩家与 Agent 双向同源：页签里手改即写入明文 JSON，Agent 在会话里更新后会随轮询同步到页签。

### 四、骰子判定（判定先行）
- 通用骰：`NdM±K`、`d%`、`4d6kh3`（取高/取低）。
- 命名检定：按规则书技能表自动取属性 + 技能修正。
- **难度语义**（与规则书 `difficultyLadder` 一致）：
  - `direction: rollUnder`（低骰成功）→ 目标值 = **属性 + 技能 + 难度修正 + 临时修正**，阶梯的 `value` 是修正值（`-50 近乎奇迹` … `+40 显而易见`，缺省 0）；
  - `direction: rollOver`（高骰成功）→ 目标值 = **难度（绝对阈值）− 临时修正**，缺省用 `defaultDifficulty`。
- 大成功/大失败 + 差值（margin）+ 难度档标签 + 一句话可引用结论。
- **对抗判定**：双方各掷一次（对手也可用固定值），潜行 vs 侦查、擒抱 vs 挣脱、谎言 vs 洞察。
- 每一次判定都追加写入 `{工作区}/.scorpio/dice.jsonl`（append-only，可用 `scorpio_ledger` 或页签「判定」子页复盘），系统提示词明确要求：**任何影响剧情的重要行动（玩家角色与 NPC）都必须先判定再叙事**。

## 安装

前置：本机 web profile 已挂载 `dsh-better-sidebar`（提供 `ctx.betterSidebar`；缺失时页签不会出现，其余功能不受影响）。

```bash
cd dsh-scorpio
npm install            # 首次：装 esbuild/typescript（也可复用同机其它插件的 node_modules）
npm run build          # → lib/index.js + lib/client.js
npm run selftest       # 69 项单元自测 + 35 项路由集成自测（不碰真实档案）

bash scripts/install.sh                 # 默认写 ~/.dsh/profiles/web 与 ~/.dsh/.agent-presets/scorpio
# 或: bash scripts/install.sh <profile-dir> <project-dir>

# 重启 dsh web 进程（必须：客户端 bundle 在启动时装载），然后刷新页面
```

安装脚本做四件事：构建两侧产物 → 以 `link:` 形式把 `dsh-scorpio` 写进 profile 依赖与 `dsh.profile.bundles` → `pnpm install` → 把 `preset/` 复制到 `${DSH_HOME:-~/.dsh}/.agent-presets/scorpio`（已存在则先备份为 `scorpio.bak-<时间戳>`，**绝不覆盖 shipped 的 standard/code/minimal/cordis 预设**）。若 profile 侧解析不到包名，脚本会自动把预设里的插件行改写为指向本仓库 `lib/index.js` 的绝对 `file:` 行。

卸载：`bash scripts/uninstall.sh [profile-dir] [--keep-preset]`（不动工作区里的 `.scorpio/` 与规则书 md）。之后同样需要重启 web 进程。

## 使用流程

1. 新建会话 →「Agent 预设」选 **天蝎座 Scorpio** → 侧边栏出现 🦂「天蝎座」页签。
2. 页签 →「世界书」填入工作区内的设定目录（如 `worldbook/克苏鲁`）→ **载入并绑定**。
3. 在会话里说：「按世界书生成规则书」——Agent 会用 `scorpio_rulebook_write` 写出 `{世界书名称}规则书.md`。
4. Agent 会依规则书向你**逐项提问**（想演什么样的人、属性分配、技能取向、初始物品、队友/宠物/随从）；确认后角色卡出现在页签「角色信息」里。
5. 开演：任何有失败可能的行动，Agent 都会先 `scorpio_roll`，并把骰面、难度、成败与代价讲清楚；你可以在页签「判定」里看到同一份流水，也可以自己掷一次比对。

页签顶部有一条步骤指示（世界书 → 规则书 → 角色卡 → 推演中），任何时候都能一眼看出卡在哪一步；会话里也可以让 Agent 调 `scorpio_status` 自检。

## 模型工具

| 工具 | 作用 |
| --- | --- |
| `scorpio_status` | 自检：会话 / 预设 / 工作区 / 世界书 / 规则书 / 角色卡 / 流水与下一步提示 |
| `scorpio_worldbook` | `load` 载入并绑定目录全文 · `list` · `read` 取某本全文 · `bind` 切换 · `find` 关键词检索 · `remove` |
| `scorpio_rulebook_write` | 写规则书 md + 机器可读 schema（同时重建角色卡条目；回报缺失字段与阶梯形态提醒） |
| `scorpio_rulebook_read` | 读规则书正文与 schema |
| `scorpio_character` | `get` 读角色卡 · `update` 增量补丁（属性/技能按 id upsert、物品/队友/宠物/随从、状态、经历） |
| `scorpio_roll` | 判定的唯一入口：通用骰 / 命名检定 / 难度 / 对抗 / 大成功大失败 |
| `scorpio_ledger` | 判定流水复盘（可按关键词过滤） |

七个工具在**工具体内**再次校验当前会话的预设，因此即使有人在别的预设里手工拼出工具名，也拿不到数据、写不进文件。

## 数据文件（明文 JSON，可离线复盘）

都以会话 cwd 为根，路径围栏拒绝任何越界（`..`、绝对路径、符号链接逃逸）：

| 文件 | 内容 |
| --- | --- |
| `.scorpio/worldbooks.json` | 世界书索引（清单，不含全文） |
| `.scorpio/session.json` | 会话 → 世界书绑定 |
| `.scorpio/rules/{bookId}.json` | 规则书元数据 + 机器可读 schema |
| `.scorpio/rules/{bookId}.md` | 规则书副本（原件是工作区根下的 `{书名}规则书.md`） |
| `.scorpio/characters/{sessionId}.json` | 玩家角色卡 |
| `.scorpio/dice.jsonl` | 判定流水（append-only，每行一次完整判定） |

## HTTP 路由

同源、浏览器信任围栏（loopback 或部署信任主机）之后，写操作还要求同源 `Origin`；非 Scorpio 会话一律 403。

```
GET  /scorpio/health
GET  /scorpio/whoami?sessionId=
GET  /scorpio/snapshot?sessionId=
GET  /scorpio/worldbook[?bookId=&text=1]      POST /scorpio/worldbook   {action:load|bind|rename|remove}
GET  /scorpio/worldbook/file?bookId=&rel=
GET  /scorpio/rulebook                        POST /scorpio/rulebook
GET  /scorpio/character                       POST /scorpio/character
GET  /scorpio/dice?limit=                     POST /scorpio/dice
```

## 结构

```
dsh-scorpio/
  package.json          dsh.bundle.patch + dsh.client.platform=web（双面插件清单）
  cordis.patch.yml      insert 一行: id: scorpio / name: 'dsh-scorpio'
  build.mjs             esbuild → lib/index.js（ESM, node） + lib/client.js（CJS + __ModuleLoader__ 工厂）
  src/shared/model.ts   两端共享契约（世界书 / 规则 schema / 角色卡 / 骰子 / 路由载荷）
  src/index.ts          宿主半区入口：路由 + 工具 + 提示词
  src/host/context.ts   DSH 服务的结构化「面」（不依赖 monorepo 内部类型）
  src/host/fence.ts     浏览器信任围栏
  src/host/worldbook.ts 工作区解析、会话 cwd/预设解析、世界书扫描、路径围栏
  src/host/store.ts     .scorpio 明文存储（原子写、schema 重建、流水追加）
  src/host/dice.ts      骰式解析 + 判定引擎（纯函数，随机源可注入）
  src/host/routes.ts    /scorpio/* 路由
  src/host/tools.ts     七个模型工具 + 天蝎座主持提示词段
  src/host/selftest.ts  单元自测   src/host/routetest.ts 路由集成自测
  src/client/           betterSidebar 页签：index / api / useScorpio / Worldbook / Rules / Character / Dice / ui / styles
  preset/               Agent 预设源（agent.cordis.yml + preset.yml + skills/trpg-gm）
  scripts/              install.sh / uninstall.sh
```

## 开发

```bash
npm run build          # 两侧产物
npm run typecheck      # tsc --noEmit
npm run selftest       # 单元 + 路由集成自测
```

客户端与宿主之间只有同源 JSON；浏览器里 `react` / `react-dom` 由 web shell 的冻结模块表提供（esbuild externals），其余全部内联。

## 已知边界

- 宿主半区是**进程级**挂载（bundle 行），因此它对所有会话都激活；「只在天蝎座生效」由每次请求的预设判定与工具体内的校验实现，而不是靠不装载。
- 预设是 standard 的**快照副本**，升级 dsh 不会自动更新它；需要新能力时对照新版 `standard/agent.cordis.yml` 手工同步。
- 规则书与角色卡的「一致性」由 Agent 保证（schema 决定渲染与判定取值）；页签只做结构性校验（未知属性/技能 id 会被拒绝），不做语义审核。
- 世界书扫描按扩展名与 UTF-8 判定文本：二进制、非 UTF-8 编码（如 GBK）文件会被跳过并在清单里标注原因。
- 判定使用 `crypto.randomInt`（无模偏）；`rngSource` 字段区分系统随机源与确定性随机源，便于复盘时区分真实掷骰与重放。
- 插件不构成任何形式的规则版权声明：世界书与规则书内容由你提供/生成，请自行确认使用授权。

## License

MIT

---

## v0.2 重构：三条主线

天蝎座的能力被拆成三条主线，**规则书降级为世界书的派生产物**：

```
【世界书】corpus/ 之类的世界观资料目录
   └─ 规则书 ×N   同一本世界书可以有多套不同风格的规则
【模组集】该世界下的一个个「开场引子」→ modules/{模组名}.md
【角色卡】按世界组织、可复用的角色池 → 一次冒险导入其中一张
```

每次冒险（会话）是一个**四元组**：`世界书 + 规则书 + 模组 + 角色卡`。四者齐备前不进入推演，
`scorpio_run` / `scorpio_status` 会报告还缺哪一环，`scorpio_roll` 会拒绝判定。

### 三套规则风格（同一个世界可以各来一套）

| style | 手感 | 默认骨架 |
|---|---|---|
| `d100` | 1–100 线性均匀、颗粒度细、核对属性与技能加成、节奏偏慢，适合调查/扮演/恐惧与代价 | `1d100` 低骰成功，阶梯为修正值（-50…+40） |
| `d20` | 1–20 颗粒度粗、加值随等级线性增长、DC 随等级膨胀，适合英雄奇幻 / 战术战斗 / 升级成长 | `1d20+5` 高骰，阶梯为绝对阈值 |
| `d6pool` | 多枚 d6 钟形分布、中间区间影响最大、结果可预期、能力越强越稳定 | `5d6`，`poolTarget: 5` → 结算比较**成功数** |

### UI

侧边栏「天蝎座」页签只保留 **三个子页**：**世界书**（规则书作为它的子项折叠在下面）、**模组集**、**角色卡**。
判定不再占一个页签，而是 `shell.overlay` 上的**可拖拽悬浮卡**（🎲 可折叠成圆钮，位置按会话记忆），
随时可以自己掷一次——判定是贯穿整场推演的底层能力。

### 工具面（8 个）

| 工具 | 作用 |
| --- | --- |
| `scorpio_status` | 自检：世界书 / 规则书 / 模组 / 角色池 / 四元组进度 / 流水 |
| `scorpio_worldbook` | `load` `list` `read` `bind` `find` `remove` + **`write_rulebook`（带 style）** `list_rules` `read_rulebook` `select_rulebook` `remove_rulebook` |
| `scorpio_module` | `generate`（开场引子）`list` `read` `select` `save` `remove` |
| `scorpio_character` | `list`（角色池）`generate`（依世界+规则+模组生成候选）`select`（导入本会话）`get` `update` `save` |
| `scorpio_roll` | 判定（需四元组齐备） |
| `scorpio_ledger` | 判定流水复盘 |
| `scorpio_run` | 四元组：`get` / `set` / `start` |

### 数据文件（v0.2）

```
.scorpio/worlds/index.json                 世界书
.scorpio/rules/index.json                  规则书 { worldId: [Rulebook…] }
.scorpio/modules/index.json                模组集 { worldId: [Module…] }
.scorpio/characters/index.json             角色池 { worldId: [CharacterTemplate…] }
.scorpio/characters/instances/{sid}.json   会话中正在扮演的角色卡
.scorpio/session.json                      会话 → 四元组
.scorpio/dice.jsonl                        判定流水
```

> v0.1 的旧结构（`.scorpio/worldbooks.json`、`.scorpio/rules/{bookId}.json`、`.scorpio/characters/{sid}.json`）
> **不再被读取**，旧文件原样留在磁盘上作为历史痕迹。旧工具名（`scorpio_rulebook_*`）已移除。
