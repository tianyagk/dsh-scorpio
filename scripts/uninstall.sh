#!/usr/bin/env bash
# dsh-scorpio 卸载脚本
#
# 用法:  bash scripts/uninstall.sh [profile-dir] [--keep-preset]
#   profile-dir   默认 ${DSH_PROFILE_DIR:-$HOME/.dsh/profiles/web}
#   --keep-preset 只摘插件行，保留 ~/.dsh/.agent-presets/scorpio 预设目录
#
# 工作区里的数据不会被删除：{工作区}/.scorpio/ 与规则书 md 都是你的战役档案，
# 需要的话自己留档。
set -euo pipefail

PROFILE_DIR="${1:-${DSH_PROFILE_DIR:-$HOME/.dsh/profiles/web}}"
KEEP_PRESET="${2:-}"
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
PRESET_DIR="$DSH_HOME_DIR/.agent-presets/scorpio"

if [ ! -f "$PROFILE_DIR/package.json" ]; then
  echo "找不到 profile: $PROFILE_DIR" >&2
  exit 1
fi

echo "① 从 $PROFILE_DIR 摘除 dsh-scorpio …"
node - "$PROFILE_DIR" <<'EOF'
const fs = require('node:fs')
const path = require('node:path')
const profileDir = process.argv[2]
const file = path.join(profileDir, 'package.json')
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'))
let changed = false
if (pkg.dependencies && pkg.dependencies['dsh-scorpio'] !== undefined) {
  delete pkg.dependencies['dsh-scorpio']
  changed = true
}
const bundles = pkg.dsh?.profile?.bundles
if (Array.isArray(bundles)) {
  const next = bundles.filter((name) => name !== 'dsh-scorpio')
  if (next.length !== bundles.length) {
    pkg.dsh.profile.bundles = next
    changed = true
  }
}
if (changed) {
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n')
  console.log('   → 已更新', file)
} else {
  console.log('   → 未注册，跳过')
}
EOF

if command -v pnpm >/dev/null 2>&1; then
  (cd "$PROFILE_DIR" && pnpm install --no-frozen-lockfile) || true
fi

if [ "$KEEP_PRESET" = "--keep-preset" ]; then
  echo "② 保留预设目录 $PRESET_DIR（--keep-preset）"
else
  if [ -e "$PRESET_DIR" ]; then
    echo "② 删除预设目录 $PRESET_DIR …"
    rm -rf "$PRESET_DIR"
  else
    echo "② 预设目录不存在，跳过"
  fi
fi

cat <<EOF

✅ dsh-scorpio 已卸载（重启 dsh web 进程后生效）

  注意: 工作区里的 .scorpio/ 与 *规则书.md 未被删除。
EOF
