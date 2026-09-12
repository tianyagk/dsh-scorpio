#!/usr/bin/env bash
# dsh-scorpio 安装脚本
#
# 用法:  bash scripts/install.sh [profile-dir] [project-dir]
#   profile-dir  默认 ${DSH_PROFILE_DIR:-$HOME/.dsh/profiles/web}
#   project-dir  默认仓库根目录（本脚本所在目录的上一级）
#
# 做四件事：
#   1. 构建 lib/index.js + lib/client.js（缺 node_modules 时会提示）
#   2. 把本插件以 link: 形式加入 profile 依赖，并追加到 dsh.profile.bundles
#   3. 安装 pnpm 依赖（link 方式通常无需网络，本地 link 即可生效）
#   4. 把 preset/ 复制到 ${DSH_HOME:-$HOME/.dsh}/.agent-presets/scorpio
#      （已存在时先备份为 scorpio.bak-<时间戳>，绝不覆盖用户其它预设）
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE_DIR="${1:-${DSH_PROFILE_DIR:-$HOME/.dsh/profiles/web}}"
PROJECT_DIR="${2:-$HERE}"
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
PRESET_ROOT="$DSH_HOME_DIR/.agent-presets"
PRESET_DIR="$PRESET_ROOT/scorpio"

if [ ! -f "$PROFILE_DIR/package.json" ]; then
  echo "找不到 profile: $PROFILE_DIR（可用 \$1 或 DSH_PROFILE_DIR 指定）" >&2
  exit 1
fi

if [ ! -d "$PROJECT_DIR/node_modules" ]; then
  echo "缺少 $PROJECT_DIR/node_modules —— 请先在该目录执行 npm install（或用同一台机器上 dsh-tradewatcher 的 node_modules 复制一份）" >&2
  exit 1
fi

# ── 1. 构建 ─────────────────────────────────────────────────────────────────
echo "① 构建 $PROJECT_DIR …"
(cd "$PROJECT_DIR" && node build.mjs)

# ── 2. 注册到 profile ───────────────────────────────────────────────────────
echo "② 注册 dsh-scorpio 到 $PROFILE_DIR …"
node - "$PROFILE_DIR" "$PROJECT_DIR" <<'EOF'
const fs = require('node:fs')
const path = require('node:path')
const [profileDir, projectDir] = process.argv.slice(2)
const file = path.join(profileDir, 'package.json')
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'))
pkg.dependencies = pkg.dependencies ?? {}
pkg.dsh = pkg.dsh ?? {}
pkg.dsh.profile = pkg.dsh.profile ?? {}
pkg.dsh.profile.bundles = pkg.dsh.profile.bundles ?? []
const spec = `link:${projectDir}`
let changed = false
if (pkg.dependencies['dsh-scorpio'] !== spec) {
  pkg.dependencies['dsh-scorpio'] = spec
  changed = true
}
if (!pkg.dsh.profile.bundles.includes('dsh-scorpio')) {
  pkg.dsh.profile.bundles.push('dsh-scorpio')
  changed = true
}
if (changed) {
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n')
  console.log('   → 已写入', file)
} else {
  console.log('   → 已经注册过，跳过')
}
EOF

# ── 3. 安装依赖（pnpm link 本地目录，通常离线可完成）────────────────────────
echo "③ 同步 profile 依赖 …"
if command -v pnpm >/dev/null 2>&1; then
  (cd "$PROFILE_DIR" && pnpm install --no-frozen-lockfile) || {
    echo "   ⚠️ pnpm install 失败 —— 请手动执行: (cd $PROFILE_DIR && pnpm install)" >&2
  }
else
  echo "   ⚠️ 未找到 pnpm —— 请手动执行: (cd $PROFILE_DIR && pnpm install)" >&2
fi

if [ ! -e "$PROFILE_DIR/node_modules/dsh-scorpio" ]; then
  echo "   ⚠️ $PROFILE_DIR/node_modules/dsh-scorpio 不存在：预设里的插件行可能解析失败，请确认上面这步成功。" >&2
fi

# ── 4. 安装 Agent 预设 ──────────────────────────────────────────────────────
echo "④ 安装 Agent 预设到 $PRESET_DIR …"
mkdir -p "$PRESET_ROOT"
if [ -e "$PRESET_DIR" ]; then
  BACKUP="$PRESET_DIR.bak-$(date +%Y%m%d-%H%M%S)"
  mv "$PRESET_DIR" "$BACKUP"
  echo "   → 已有预设已备份为 $BACKUP"
fi
cp -R "$PROJECT_DIR/preset" "$PRESET_DIR"
chmod 700 "$PRESET_DIR" 2>/dev/null || true
find "$PRESET_DIR" -type d -exec chmod 700 {} + 2>/dev/null || true
find "$PRESET_DIR" -type f -exec chmod 600 {} + 2>/dev/null || true

# 预设里的插件行默认写包名 `dsh-scorpio`。但**预设的 mount 用 ESM import 解析
# 裸包名**：ESM 不认 NODE_PATH，也不会去 profile 的 node_modules 里找，而预设目录
# （~/.dsh/.agent-presets/scorpio）之上没有能提供该包的 node_modules 祖先，因此
# 裸包名在 mount 时会 ERR_MODULE_NOT_FOUND 并把整个会话创建回滚。
#
# 所以这里做一个**与 mount 同方式**的探测（从预设目录 ESM import），探测失败就把
# 插件行改写为指向本仓库构建产物的绝对 file: 行 —— 预设的 mount 接受绝对路径，
# 且预设目录被整体复制后该路径依然有效。
PROBE="$PRESET_DIR/.row-resolve-probe.mjs"
cat > "$PROBE" <<'PROBEEOF'
try {
  const mod = await import('dsh-scorpio')
  if (typeof mod.apply !== 'function') throw new Error('missing apply export')
  console.log('OK')
} catch (error) {
  console.log('FAIL ' + (error && error.code ? error.code : String(error)))
}
PROBEEOF
PROBE_RESULT="$(cd "$PRESET_DIR" && node .row-resolve-probe.mjs 2>/dev/null | tail -1 || true)"
rm -f "$PROBE"

if [ "$PROBE_RESULT" = "OK" ]; then
  echo "   → 预设插件行保持包名 \`dsh-scorpio\`（从预设目录 ESM 可解析）"
else
  ENTRY="$PROJECT_DIR/lib/index.js"
  node - "$PRESET_DIR/agent.cordis.yml" "$ENTRY" "$PROBE_RESULT" <<'EOF'
const fs = require('node:fs')
const [file, entry, probe] = process.argv.slice(2)
const text = fs.readFileSync(file, 'utf8')
const rewritten = text.replace(/^(\s*name:\s*)'dsh-scorpio'\s*$/m, `$1'file:${entry}'`)
if (rewritten === text) {
  console.log('   ⚠️ 未找到可改写的插件行，请手动确认', file)
} else {
  fs.writeFileSync(file, rewritten)
  console.log(`   → 裸包名无法从预设目录解析（${probe || 'ESM 解析失败'}），插件行已改写为 file:${entry}`)
}
EOF
fi

cat <<EOF

✅ dsh-scorpio 已就位

  插件行     : $PROFILE_DIR（bundle: dsh-scorpio）
  Agent 预设 : $PRESET_DIR/agent.cordis.yml（id: scorpio）

下一步（必须）:
  重启 dsh web 进程 —— 客户端 bundle 在启动时装载，重启后刷新页面。
  然后新建会话，在「Agent 预设」里选择「天蝎座 Scorpio」，
  侧边栏会出现「天蝎座」页签（🦂）。

  卸载: bash $PROJECT_DIR/scripts/uninstall.sh "$PROFILE_DIR"
EOF
