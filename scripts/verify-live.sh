#!/usr/bin/env bash
# 重启 dsh web 之后运行一次：`bash scripts/verify-live.sh [url]`
#
# 检查插件是否真的在运行中的进程里生效：
#   1. /scorpio/health 返回 JSON（而不是 SPA 的 index.html —— 那是「路由没注册」的迹象）
#   2. 宿主半区的 whoami 对未知会话返回 403（说明预设闸门在工作）
#   3. 客户端 bundle 出现在 GUI 的启动清单里（__DSH_BOOT__ 含 dsh-scorpio）
#
# 用法:  bash scripts/verify-live.sh                 # 默认 http://127.0.0.1:3080
#        bash scripts/verify-live.sh http://127.0.0.1:8080
set -uo pipefail

BASE="${1:-http://127.0.0.1:3080}"
pass=0
fail=0

say() { printf '%s %s\n' "$1" "$2"; }
ok()  { say '✓' "$1"; pass=$((pass + 1)); }
bad() { say '✗' "$1"; fail=$((fail + 1)); }

echo "── 检查 $BASE ──"

HEALTH="$(curl -s -m 5 "$BASE/scorpio/health" || true)"
case "$HEALTH" in
  *'"name":"dsh-scorpio"'*)
    ok "/scorpio/health 返回宿主半区的 JSON：$HEALTH"
    ;;
  *'<html'*|*'<!doctype'*)
    bad "/scorpio/health 返回了 SPA 页面 —— 路由未注册（进程还没重启，或插件行未装载）"
    ;;
  '')
    bad "/scorpio/health 无响应（web 进程没在跑？）"
    ;;
  *)
    bad "/scorpio/health 响应异常：$HEALTH"
    ;;
esac

# whoami 是「页签提示」通道：对任何会话都放行，只回 scorpio:true/false。
WHO="$(curl -s -m 5 "$BASE/scorpio/whoami?sessionId=verify-nonexistent" || true)"
case "$WHO" in
  *'"scorpio":false'*) ok "whoami 对未知会话正常作答（scorpio:false，这是页签提示通道）" ;;
  '') bad "whoami 无响应" ;;
  *) bad "whoami 响应异常：$WHO" ;;
esac

# 真正的闸门在 snapshot 与写操作：未知会话必须 403。
SNAP="$(curl -s -m 5 -o /dev/null -w '%{http_code}' "$BASE/scorpio/snapshot?sessionId=verify-nonexistent" || true)"
if [ "$SNAP" = "403" ]; then
  ok "snapshot 对未知会话返回 403（预设闸门在工作）"
else
  bad "snapshot 对未知会话返回 $SNAP（期望 403）"
fi

INDEX="$(curl -s -m 8 "$BASE/" || true)"
if printf '%s' "$INDEX" | grep -q '"id":"dsh-scorpio"'; then
  ok "客户端启动清单 __DSH_BOOT__ 里已包含 dsh-scorpio"
else
  bad "客户端启动清单里没有 dsh-scorpio —— 刷新页面确认，或检查 profile 的 dsh.profile.bundles"
fi

if printf '%s' "$INDEX" | grep -q '"id":"dsh-better-sidebar"'; then
  ok "betterSidebar 已装载（页签有落脚点）"
else
  bad "betterSidebar 不在启动清单里 —— 天蝎座页签不会出现"
fi

echo
echo "结论：$pass 项通过 / $fail 项失败"
if [ "$fail" -gt 0 ]; then
  cat <<'EOF'

排查顺序：
  1. 进程是否真的重启过（旧进程会让 /scorpio/health 落到 SPA 回退）
  2. profile 的 package.json 是否含 "dsh-scorpio" 依赖与 dsh.profile.bundles 一行
  3. 预设插件行是否可加载：
       cd ~/.dsh/.agent-presets/scorpio && node -e "import(require('node:fs').readFileSync('agent.cordis.yml','utf8').match(/name: '(file:[^']+)'/)[1]).then(m=>console.log(m.name))"
  4. 重跑安装：bash scripts/install.sh
EOF
  exit 1
fi
exit 0
