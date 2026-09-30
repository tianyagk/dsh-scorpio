# dsh-scorpio（天蝎座 Scorpio）

DeepSeek Harness 的 **Web 插件**：把「天蝎座 Scorpio」装成一套实时推演线上 TRPG（跑团）的主持工具链，并注册成一个 **Agent 预设**（`preset/agent.cordis.yml`，id `scorpio`）。跑在该预设上的会话里，侧边栏多一个 🦂「天蝎座」页签（三个子页），界面上还浮着一张可拖拽的判定卡。

插件版本 `0.2.0`：`src/shared/model.ts` 的 `VERSION` 是唯一来源，宿主与浏览器半区共读这一份。

> 宿主半区是**进程级**挂载、服务所有会话，所以「只在天蝎座生效」不是靠不装载实现的：每次 `/scorpio/*` 请求都要先判定这个会话的 Agent 预设，不是 `scorpio` 就一律 403；模型工具在工具体内做同一道判定。别的预设既没有这行插件，也没有这段主持提示词。

## 概念模型：三条主线 + 判定

```
【世界书】工作区里的一个资料目录（递归扫描其中的全部文本）
   └─ 规则书 ×N    同一个世界可以有多套不同风格：d100 / d20 / d6 骰池 / 自定义
【模组集】某个世界下的一个个「开场引子」：从哪一幕开始、关键 NPC、悬念与走向
【角色卡】按世界组织、可复用的角色池；一次冒险把其中一张导入成正在扮演的角色
【判定】  任何有失败可能、且失败有意义的行动，都先掷骰再叙事
```

每次冒险（会话）是一个**四元组**：`世界书 + 规则书 + 模组 + 角色卡`。四者齐备前不进入叙事——`scorpio_run` / `scorpio_status` 报告还缺哪一环，`scorpio_roll` 直接拒绝判定。开局顺序固定为 **世界书 → 规则书 → 模组 → 角色卡 →（`scorpio_run action=start`）开演**。

判定只分叉在「方向」上，其余共用一套语义：`rollUnder`（低骰成功）的目标值 = 属性 + 技能 + 难度修正 + 临时修正；`rollOver`（高骰成功）的目标值 = 难度（绝对阈值）− 临时修正；d6 骰池则把「骰面 ≥ `poolTarget` 的个数」当成功数去比。对抗判定双方各掷一次，比较**各自相对目标的余量**（`opposed.value` 是**对手的目标值**，留空表示与玩家同目标、纯比骰运）。命名检定按规则书 `skills[].attribute` 自动取属性与技能修正；大成功 / 大失败由 schema 的 `critSuccess` / `critFailure` 区间判定。

## 三套规则风格（`style`）

| style | 手感 | 默认骨架（`RULE_STYLES`） |
| --- | --- | --- |
| `d100` | 骰值 1–100 线性均匀，每一档修正都看得见；颗粒度细、要核对属性与技能、节奏偏慢，适合调查 / 扮演 / 恐惧与代价主题 | `1d100` 低骰成功；阶梯是**修正值**：近乎奇迹 -50 … 普通 0（缺省）… 显而易见 +40 |
| `d20` | 骰值 1–20 颗粒度粗、细微差异容易被淹没；加值随等级线性增长、DC 同步抬升形成等级膨胀，适合英雄奇幻与战术战斗 | `1d20` 高骰成功；阶梯是**绝对阈值**：轻松 8 / 普通 12（缺省）/ 困难 16 / 极难 20 / 近乎不可能 25 |
| `d6pool` | 多枚 d6 组成骰池，成功数呈钟形分布：中间区间影响最大、极端区间影响小，结果更可预期、少翻车，能表现「能力越强越稳定」，代价是统计稍繁琐 | `4d6`，`poolTarget: 5` → 骰面 ≥ 5 记一个成功，结算比**成功数**，缺省难度 2 |
| `custom` | 按世界观现场裁量，但骰式、方向、难度与结算都必须写进 schema 与正文 | `2d6` 高骰成功，缺省阈值 8 |

schema 的其余部分由模型按世界书写：属性表、技能表、难度阶梯、大成功/大失败区间、状态系统（`statusSystem`）、平手裁定（`opposedTie: defender | reroll | gm`，缺省 `gm`）。同一本世界书可以并存多套规则，会话里随时切换。

## 界面

- **三个子页**：**世界书**（规则书作为它的子项折叠在下面，同一世界的多套规则可「选用」；世界书里的源文件是只读预览）、**模组集**（可从列表挑选，也可以手写 / 套骨架后保存一个模组）、**角色卡**（角色池 + 会话中正在扮演的那张；属性与技能按 schema 渲染，`pending` 的项标「待确认」，点一下即确认）。
- **悬浮判定卡**：注册在 `ctx.slots` 的 `shell.overlay` 上（frame-wide 浮层），可拖拽、可折叠成一个 🎲 圆钮，位置按会话记在 `localStorage`；底色不透明度 0.35–1.00 可调（默认 0.82）。命名检定 / 骰式 / 难度 / 对抗都在这一张卡上掷。
- **判定没有独立子页**：它是贯穿整场推演的底层能力，所以做成常驻浮层，而不是第四个页签。
- **面板解锁只看预设**：页签的 `available` 谓词只问「当前会话选的 Agent 预设是不是天蝎座」，与世界书 / 规则书 / 模组 / 角色卡是否就绪**完全无关**；那四样只决定「能不能开演」（面板顶部与提示条会写明「开局序章未齐 · 面板已解锁」）。预设已被删除的会话也保留入口，点进去看到的是修复说明。
- 面板每 8 秒轮询一次 snapshot；页签角标是**待玩家确认的属性条数**，每 20 秒刷新一次。

## 模型工具（7 个）

| 工具 | 作用 |
| --- | --- |
| `scorpio_worldbook` | 世界书 **及其规则书**：`load`（扫描并绑定）`list` `read` `bind` `find` `remove`；`write_rulebook`（正文 + 机器可读 schema，同一世界可多套）`list_rules` `read_rulebook` `select_rulebook` `remove_rulebook` |
| `scorpio_module` | 开场引子：`generate` `list` `read` `select` `save` `remove`（`generate` / `save` 需要模型给出 markdown——工具只负责落盘与登记） |
| `scorpio_character` | 角色池与会话角色：`list`（角色池）`generate`（依世界 + 规则 + 模组生成候选，默认不直接开演）`select`（导入本会话）`get` `update`（属性 / 技能按 id upsert，物品 / 队友 / 宠物 / 随从 / 状态 / 经历合并）`save` |
| `scorpio_roll` | 判定唯一入口：通用骰、命名检定、难度、对抗、大成功/大失败；结果自动写入流水 |
| `scorpio_ledger` | 判定流水复盘（可按关键词过滤） |
| `scorpio_run` | 四元组总控：`get` / `set` / `start` |
| `scorpio_status` | 自检：会话、预设、工作区、世界书、该世界的规则书、模组、角色卡、流水与下一步 |

工具只在 Scorpio 预设下可用；四元组未齐备时 `scorpio_roll` 会指出缺哪一环，而不是硬算。

## 开局四元组流程

1. **世界书**：`scorpio_worldbook action=load path=<工作区内的目录>` → 递归扫描文本文件并绑定到本会话；大目录可用 `listOnly` 只登记清单。目录里一个文本文件都没有会被拒绝。
2. **规则书**：`action=write_rulebook`，必须同时给 `markdown` 与 `schema`（含属性表、技能表、判定公式、难度阶梯、大成功/大失败、状态系统）；写完用 `action=list_rules` 让玩家挑，`action=select_rulebook` 切换。
3. **模组**：`scorpio_module action=generate` 写出开场引子（一句话钩子 / 序幕与初始局面 / 关键 NPC / 悬念与走向 / 首场判定提示），也可以用 `action=list` 从已有模组里挑。
4. **角色卡**：`scorpio_character action=generate` 依「世界 + 规则 + 这个模组」把候选写进角色池；用 `ask_user_question` 让玩家在候选之间挑选并逐项确认（姓名/概念、属性分配、技能取向、初始物品、队友/宠物/随从、开场处境）；`action=select templateId=…` 导入本会话。属性 / 技能 id 必须来自规则书 schema，未确认的保留 `pending`。
5. **开演**：`scorpio_run action=start`（四元组不齐备会被拒绝），然后从模组的第一幕开始；此后每次重要行动先 `scorpio_roll`。

## 数据文件

状态都落在工作区的 `.scorpio/` 明文 JSON 里，玩家可以直接读改：

```
.scorpio/worlds/index.json                 世界书（清单 + 文件表）
.scorpio/rules/index.json                  规则书，按世界分组 { worldId: [Rulebook…] }
.scorpio/modules/index.json                模组集，按世界分组
.scorpio/characters/index.json             角色池，按世界分组
.scorpio/characters/instances/{sid}.json   会话中正在扮演的角色卡
.scorpio/session.json                      会话 → 四元组 { v:2, sessions: { <sid>: { worldId, rulebookId, moduleId, templateId } } }
.scorpio/dice.jsonl                        判定流水（append-only，每行 { v:1, entry:{…} }）
```

写盘是原子替换（同目录临时文件 + `rename`，临时名带随机 UUID），同一路径的写按 Promise 链串行；读取遇到坏 JSON 会先把它备份成 `*.corrupt-<时间戳>`，再当空表处理（不会静默丢文件）。

工作区里另有玩家可见的产物：规则书 `<书名>规则书（<style>）.md`（书名取 `world.rulesName ?? world.name`），模组 `modules/<模组名>.md`。产物路径受职责边界约束——拒绝 `.scorpio/`、拒绝 `..` 与绝对路径、必须是 `.md`、且不许落在任何已登记的世界书目录内（那里是玩家的源资料），越界返回 400。

## HTTP 路由

所有路由都在浏览器信任围栏之后：`Host` 必须是 loopback 或部署信任的主机，带 `sec-fetch-site: cross-site` 的请求直接拒绝；**写操作**（POST）额外要求 `Origin` 与 `Host` 同源；会话不属于天蝎座预设一律 403；会话没有工作区则 409。

| 路径 | 方法 | 说明 |
| --- | --- | --- |
| `/scorpio/health` | GET | 插件名 / 版本 / 预设 id |
| `/scorpio/whoami` | GET `?sessionId=` | 会话的预设与 cwd（页签与悬浮卡据此决定是否渲染；对未知会话也作答，`scorpio:false`） |
| `/scorpio/snapshot` | GET `?sessionId=` | 三个子页 + 悬浮卡一次拉齐（世界 / 规则 / 模组 / 角色池 / 流水 / 四元组） |
| `/scorpio/world` | GET / POST | GET 取世界书（`?text=1` 重新扫描并带全文）；POST `action=load` `bind` `rename` `remove` |
| `/scorpio/world/file` | GET `?worldId=&rel=` | 读世界书里的单个文本（只读；`rel` 必须在该世界书清单内） |
| `/scorpio/rulebook` | GET / POST | GET 列表 + 选中那套的正文；POST 写一套（给 `rulebookId` 即覆盖），默认选为当前会话规则并重建会话角色卡 |
| `/scorpio/module` | GET / POST | GET 列表 + 正文；POST 写一个，或 `action=select` / `action=remove` |
| `/scorpio/character` | GET / POST | GET 会话中正在扮演的角色卡；POST 写池子或写会话实例（未提供的字段不会覆盖已存值） |
| `/scorpio/pool` | GET / POST | GET 角色池；POST `action=remove` 删一张 / `action=import` 导入本会话 |
| `/scorpio/run` | GET / POST | GET 四元组与还缺哪几环；POST 设置四元组（给 `templateId` 会顺手把那张模板导入为会话角色） |
| `/scorpio/dice` | GET / POST | GET 判定流水（默认尾部 60 条，最多 200）；POST 掷骰，结果追加到流水 |

## 安装 / 卸载 / 验证

前置：web profile 已挂载 `dsh-better-sidebar`（页签的落脚点，缺失时页签不出现、其余功能不受影响），且本目录已 `npm install`。

```bash
cd dsh-scorpio
npm install
bash scripts/install.sh                 # 默认写 ~/.dsh/profiles/web 与 ${DSH_HOME:-~/.dsh}/.agent-presets/scorpio
# 或: bash scripts/install.sh <profile-dir> <project-dir>
```

`install.sh` 做四件事：① `node build.mjs` 构建两侧产物；② 以 `link:` 把 `dsh-scorpio` 写进 profile 依赖并追加到 `dsh.profile.bundles`；③ `pnpm install --no-frozen-lockfile`；④ 把 `preset/` 整目录复制到 `.agent-presets/scorpio`（已存在则先备份成 `scorpio.bak-<时间戳>`，并把目录 / 文件权限收紧到 700 / 600），**绝不会覆盖 shipped 的预设**。

预设里的插件行默认写包名 `dsh-scorpio`；但预设的 mount 用 ESM 解析裸包名，而预设目录之上没有能提供该包的 `node_modules` 祖先——脚本因此会从预设目录做一次同方式的 ESM 探测，失败就把那一行改写成指向本仓库 `lib/index.js` 的绝对 `file:` 行（整目录复制后依然有效）。

安装 / 卸载后**必须重启 dsh web 进程**（客户端 bundle 在进程启动时装载），然后刷新页面，新建会话并在「Agent 预设」里选「天蝎座 Scorpio」。

```bash
bash scripts/verify-live.sh             # 默认 http://127.0.0.1:3080
bash scripts/uninstall.sh [profile-dir] [--keep-preset]
```

`verify-live.sh` 检查五件事：`/scorpio/health` 返回宿主 JSON（而不是 SPA 回退）、`whoami` 对未知会话正常作答、`snapshot` 对未知会话 403（闸门在工作）、`__DSH_BOOT__` 里含 `dsh-scorpio` 与 `dsh-better-sidebar`。卸载只摘 profile 依赖与（默认）预设目录，**不动**工作区里的 `.scorpio/`、规则书 md 与模组 md。

## 开发

```bash
npm run build         # esbuild → lib/index.js（ESM, node）+ lib/client.js（CJS + __ModuleLoader__ 信封）
npm run typecheck     # tsc --noEmit -p tsconfig.json
npm run selftest      # 五个套件：单元 + /scorpio/* 路由 + 客户端 markdown 解析 + 预设回归 + 预设解析探针
npm test              # 只跑单元自测
npm run test:routes   # 只跑路由自测
npm run test:preset   # 只跑预设回归
npm run test:markdown # 只跑客户端 markdown 解析自测
```

- `src/shared/model.ts` 是两端共享契约，全部是**无损 JSON** 类型：要么落成工作区明文文件，要么跨 `/scorpio/*` 传给浏览器，绝不引入 Node 或 DSH 运行时对象。
- `src/client/markdown.ts`（规则书 / 模组正文的渲染解析）刻意不 import react，这样它能像宿主模块一样被 node 原生跑测试；渲染层 `ui.tsx` 只是引用它。
- 客户端 bundle 里 `react` / `react-dom` / `cordis` 是 esbuild externals（由 web shell 的冻结模块表提供），其余全部内联。
- 其余结构与 UI 细节以源码为准：`src/host/`（路由 / 存储 / 判定 / 工具）、`src/client/`（页签与悬浮卡）。

## 已知边界与限制

- **面板解锁只看预设**，与初始化完成度无关：会话一开就能打开三个子页（世界书源文件是只读预览，模组与角色卡可编辑），四元组只影响「能不能开演」。预设被删除的会话保留入口，点进去看到的是修复说明而不是空白页。
- **两个挂载点是两个不同的东西**：页签走 `ctx.betterSidebar`（客户端声明 `inject: ['betterSidebar']`），悬浮判定卡走 `ctx.slots` 的 `shell.overlay`；`slots` 服务缺失时只有判定卡不出现，页签照常可用。
- **跨会话并发写同一索引是 last-writer-wins**：`worlds/index.json` 与 `session.json` 已事务化（读-改-写进同一把路径锁）；`rules` / `modules` / `characters` 三个索引仍是「读一次 → 整体覆盖写」，两个会话同时写同一个索引会丢其中一侧的更新。
- **换规则书 / 换世界会剔除属性与技能且无备份**：按新 schema 重建角色卡时，不在新 schema 里的属性、技能被过滤掉，值一并丢弃，没有备份文件；新条目以 `pending` 标「待确认」。换世界还会清掉属于旧世界的规则书 / 模组 / 角色卡选择，避免出现跨世界的四元组。
- **自动化覆盖不对称**：`/scorpio/*` 由 `src/host/routetest.ts` 用假 ctx 直接驱动真实 handler 覆盖（预设闸门、产物边界、写入语义、请求形状）；客户端能自动测到的只有不 import react 的 markdown 解析器（`src/client/markdowntest.ts`），三个子页与悬浮判定卡本身仍没有自动化测试，只能靠 `scripts/verify-live.sh` 与手测。
- **`lib/` 不入库**（见 `.gitignore`）：clone 后必须 `npm install` + `npm run build`，否则 profile 里那一行解析不到产物；`scripts/install.sh` 在缺 `node_modules` 时会直接退出。
- 宿主半区进程级挂载、对所有会话激活，「只在天蝎座生效」由请求级预设判定与工具体内校验实现，不是靠不装载。
- 预设是 standard 的快照副本（另外附一份 `trpg-gm` 主持手法 skill）：升级 dsh 不会自动同步它，需要新能力时得手工对照新版 `standard/agent.cordis.yml`。
- 世界书扫描按扩展名与 UTF-8 判定：二进制 / 非 UTF-8 文件被跳过并在清单里标注原因；单文件截断在 240,000 字符、整本 1,200,000 字符、最多 600 个文件、最深 6 层；符号链接指向工作区外的一律跳过。
- `presettest` 不是纯离线单测：它用本机 dsh 安装里的 YAML 方言解析预设，并读 profile 路径（可用 `SCORPIO_PROFILE` / `SCORPIO_PRESET` 覆盖）。
- 判定随机源是 `crypto.randomInt`（无模偏）；`rngSource` 区分 os / seeded，便于复盘时分辨真实掷骰与重放。
- 插件不附带任何规则版权内容：世界书、规则书、模组都是你提供或生成的工作区文件。

## 历史

v0.1 → v0.2 是一次**不兼容重构**：`scorpio_rulebook_write` / `scorpio_rulebook_read` 两个工具名已并入 `scorpio_worldbook` 的 action；侧边栏的「判定」子页已移除，判定改为 `shell.overlay` 上的悬浮卡。旧数据文件 `.scorpio/worldbooks.json`、`.scorpio/rules/{bookId}.json`、`.scorpio/characters/{sid}.json` 与旧路由 `/scorpio/worldbook` **不再被读写**；旧文件原样留在磁盘上作为历史痕迹，不做清理。

## License

MIT
