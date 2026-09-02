#!/usr/bin/env bash
# codex-login-remote.sh — 在远端 a2wave 容器里登录 codex（ChatGPT OAuth）
#
# 用法:
#   ./scripts/codex-login-remote.sh [选项]
#
# 选项:
#   --host <ip>     远程主机 IP（环境变量 DEPLOY_HOST，必填）
#   --user <user>   SSH 用户名（环境变量 DEPLOY_USER，必填）
#   --pass <pass>   SSH/sudo 密码（环境变量 DEPLOY_PASS，必填）
#   --container <name>  容器名（默认 a2wave）
#   --port <p>      宿主机临时中转端口（默认 1456；本机浏览器仍用 1455）
#   --status        只查登录态，不走登录流程
#   --logout        清掉容器里的 ~/.codex/auth.json（强制重新登录）
#   --help
#
# SSH host key (optional; unset = accept-new, i.e. record on first contact, then pin):
#   DEPLOY_KNOWN_HOSTS_FILE  known_hosts file to verify the host against (strict)
#   DEPLOY_HOST_KEY          a single known_hosts line ("<host> ssh-ed25519 AAAA…")
#
# 背景:
#   codex login 在容器里启动一个 HTTP 服务监听 127.0.0.1:1455 接收 OAuth 回调。
#   容器内的 127.0.0.1 在宿主机网络里不可达，且 codex 已占用 1455，所以本地
#   socat 没法直接绑 1455 转发。脚本的做法:
#     1) 容器内 socat 在 <PORT>（默认 1456）监听，转发到 127.0.0.1:1455
#     2) 在你执行此脚本的机器上起 ssh -L 1455:<容器IP>:<PORT>，把本机 1455
#        转到远端容器
#     3) 在远端容器里前台跑 codex login，它会打印 http://localhost:1455/...
#        URL；你在本机浏览器打开，OAuth 回调走 SSH 隧道 → socat → codex
#     4) auth.json 写到挂载的 ~/.codex 卷里，重启容器不丢
#
# 前置条件:
#   远端容器必须挂载了 /home/appuser/.codex，否则登录态不会持久化（看 deploy-remote.sh）
set -euo pipefail

REMOTE_HOST="${DEPLOY_HOST:-}"
REMOTE_USER="${DEPLOY_USER:-}"
REMOTE_PASS="${DEPLOY_PASS:-}"
CONTAINER_NAME="a2wave"
RELAY_PORT=1456
ACTION="login"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host)       REMOTE_HOST="$2";    shift 2 ;;
    --user)       REMOTE_USER="$2";    shift 2 ;;
    --pass)       REMOTE_PASS="$2";    shift 2 ;;
    --container)  CONTAINER_NAME="$2"; shift 2 ;;
    --port)       RELAY_PORT="$2";     shift 2 ;;
    --status)     ACTION="status";     shift ;;
    --logout)     ACTION="logout";     shift ;;
    --help)
      sed -n '2,33p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *) echo "未知参数: $1"; exit 1 ;;
  esac
done

if [[ -z "${REMOTE_HOST}" ]]; then
  echo "❌ 请设置 DEPLOY_HOST 或使用 --host"
  exit 1
fi
if [[ -z "${REMOTE_USER}" ]]; then
  echo "❌ 请设置 DEPLOY_USER 或使用 --user"
  exit 1
fi
if [[ -z "${REMOTE_PASS}" ]]; then
  echo "❌ 请设置 DEPLOY_PASS 或使用 --pass"
  exit 1
fi
if ! command -v sshpass &>/dev/null; then
  echo "❌ 需要 sshpass，请先安装: brew install sshpass"
  exit 1
fi

# Host key policy and secret handling mirror deploy-remote.sh: accept-new pins the
# key on first contact instead of trusting a new one on every connection, and no
# password is ever placed in an argv (`ps auxww` is readable by any local user).
# DEPLOY_HOST_KEY / DEPLOY_KNOWN_HOSTS_FILE pin the key up front.
SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o LogLevel=ERROR)
if [[ -n "${DEPLOY_HOST_KEY:-}" ]]; then
  PINNED_KNOWN_HOSTS="$(mktemp "${TMPDIR:-/tmp}/a2wave-known-hosts.XXXXXX")"
  trap 'rm -f "${PINNED_KNOWN_HOSTS}"' EXIT
  printf '%s\n' "${DEPLOY_HOST_KEY}" > "${PINNED_KNOWN_HOSTS}"
  SSH_OPTS=(-o StrictHostKeyChecking=yes -o "UserKnownHostsFile=${PINNED_KNOWN_HOSTS}" -o LogLevel=ERROR)
elif [[ -n "${DEPLOY_KNOWN_HOSTS_FILE:-}" ]]; then
  SSH_OPTS=(-o StrictHostKeyChecking=yes -o "UserKnownHostsFile=${DEPLOY_KNOWN_HOSTS_FILE}" -o LogLevel=ERROR)
fi

REMOTE_PRELUDE='IFS= read -r A2WAVE_SUDO_PASS'
SUDO='printf "%s\n" "$A2WAVE_SUDO_PASS" | sudo -S -p ""'

# The sudo password is the first line of the remote shell's stdin.
remote() {
  SSHPASS="${REMOTE_PASS}" sshpass -e ssh "${SSH_OPTS[@]}" "${REMOTE_USER}@${REMOTE_HOST}" \
    "${REMOTE_PRELUDE}
$*" < <(printf '%s\n' "${REMOTE_PASS}") 2>&1
}

# `codex login` runs in the foreground and keeps reading this terminal, so the
# password line has to be spliced in front of the operator's own stdin. A FIFO
# fed by a background writer does that and can be torn down once ssh returns —
# a plain pipe would leave the shell waiting on a `cat` that never sees EOF.
remote_interactive() {
  local fifo status=0 feeder
  fifo="$(mktemp -u "${TMPDIR:-/tmp}/a2wave-sudo.XXXXXX")"
  mkfifo -m 600 "${fifo}"
  { printf '%s\n' "${REMOTE_PASS}"; cat; } > "${fifo}" &
  feeder=$!
  SSHPASS="${REMOTE_PASS}" sshpass -e ssh "${SSH_OPTS[@]}" "${REMOTE_USER}@${REMOTE_HOST}" \
    "${REMOTE_PRELUDE}
$*" < "${fifo}" || status=$?
  kill "${feeder}" 2>/dev/null || true
  rm -f "${fifo}"
  return "${status}"
}

# ── 子命令: status ────────────────────────────────────────────────────────────
if [[ "$ACTION" == "status" ]]; then
  echo "🔍 查询 codex 登录态..."
  remote "${SUDO} docker exec -u appuser ${CONTAINER_NAME} codex login status"
  exit $?
fi

# ── 子命令: logout ────────────────────────────────────────────────────────────
if [[ "$ACTION" == "logout" ]]; then
  echo "🗑  清除登录态..."
  remote "${SUDO} docker exec -u appuser ${CONTAINER_NAME} codex logout || true"
  echo "✅ 已尝试登出（如失败可手动删 /home/${REMOTE_USER}/a2wave-data/.codex/auth.json）"
  exit 0
fi

# ── 子命令: login ─────────────────────────────────────────────────────────────
echo "🔑 准备在远端容器里登录 codex"
echo "   目标:  ${REMOTE_USER}@${REMOTE_HOST}"
echo "   容器:  ${CONTAINER_NAME}"
echo "   中转:  127.0.0.1:1455 (本机) → ${REMOTE_HOST} → 容器:${RELAY_PORT} → 容器内 codex:1455"
echo ""

# 校验容器是否在跑、是否挂载了 .codex
echo "🔧 [1/4] 检查容器..."
STATUS=$(remote "${SUDO} docker inspect ${CONTAINER_NAME} --format '{{.State.Status}}'" || echo "missing")
if [[ "${STATUS}" != "running" ]]; then
  echo "❌ 容器 ${CONTAINER_NAME} 不在运行（status=${STATUS}）"
  exit 1
fi
HAS_MOUNT=$(remote "${SUDO} docker inspect ${CONTAINER_NAME} --format '{{range .Mounts}}{{.Destination}}{{println}}{{end}}'" | grep -c '/home/appuser/.codex' || true)
if [[ "${HAS_MOUNT}" -eq 0 ]]; then
  echo "⚠️  容器没挂载 /home/appuser/.codex —— 登录态不会持久化"
  echo "    建议先用 deploy-remote.sh 重新部署（确认脚本里有 .codex 挂载）"
  read -r -p "    仍要继续登录吗？(y/N) " yn
  [[ "${yn,,}" == "y" ]] || exit 1
fi

# 启动容器内 socat（已运行就先杀掉，避免端口残留）
echo "🔌 [2/4] 启动容器内 socat（监听 ${RELAY_PORT} → codex 127.0.0.1:1455）..."
remote "${SUDO} docker exec ${CONTAINER_NAME} pkill -f 'socat.*TCP-LISTEN:${RELAY_PORT}' || true"
remote "${SUDO} docker exec -d ${CONTAINER_NAME} socat TCP-LISTEN:${RELAY_PORT},fork,reuseaddr TCP:127.0.0.1:1455"
sleep 1
SOCAT_PID=$(remote "${SUDO} docker exec ${CONTAINER_NAME} pgrep -f 'socat.*TCP-LISTEN:${RELAY_PORT}'" | tr -d '\r' | head -1)
if [[ -z "${SOCAT_PID}" ]]; then
  echo "❌ socat 启动失败（容器内）"
  exit 1
fi
echo "✅ socat 已启动 (pid=${SOCAT_PID})"

# 拿容器 IP
CONTAINER_IP=$(remote "${SUDO} docker inspect ${CONTAINER_NAME} --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'" | tr -d '\r' | head -1)
if [[ -z "${CONTAINER_IP}" ]]; then
  echo "❌ 拿不到容器 IP"
  exit 1
fi
echo "   容器 IP: ${CONTAINER_IP}"

# 起本机 SSH 隧道（后台）
echo "🚇 [3/4] 在本机起 SSH 隧道 (127.0.0.1:1455 → ${CONTAINER_IP}:${RELAY_PORT})..."
# 杀掉同一端口的旧隧道
EXISTING=$(lsof -ti tcp:1455 -sTCP:LISTEN 2>/dev/null || true)
if [[ -n "${EXISTING}" ]]; then
  echo "   端口 1455 已被占用 (pid=${EXISTING})，先释放"
  kill "${EXISTING}" 2>/dev/null || true
  sleep 1
fi
SSHPASS="${REMOTE_PASS}" sshpass -e ssh "${SSH_OPTS[@]}" -N -f \
  -L "1455:${CONTAINER_IP}:${RELAY_PORT}" \
  "${REMOTE_USER}@${REMOTE_HOST}"
TUNNEL_PID=$(lsof -ti tcp:1455 -sTCP:LISTEN 2>/dev/null | head -1)
echo "✅ SSH 隧道已起 (pid=${TUNNEL_PID})"

cleanup() {
  echo ""
  echo "🧹 清理..."
  # This trap replaces the known-hosts one installed above, so it inherits that job.
  if [[ -n "${PINNED_KNOWN_HOSTS:-}" ]]; then rm -f "${PINNED_KNOWN_HOSTS}"; fi
  [[ -n "${TUNNEL_PID:-}" ]] && kill "${TUNNEL_PID}" 2>/dev/null || true
  remote "${SUDO} docker exec ${CONTAINER_NAME} pkill -f 'socat.*TCP-LISTEN:${RELAY_PORT}' || true" >/dev/null 2>&1 || true
  echo "✅ 已关闭隧道和容器内 socat"
}
trap cleanup EXIT INT TERM

# 在容器里前台跑 codex login，URL 会打印到这里
echo "🔐 [4/4] 启动 codex login（保持运行，回调完成后会自动结束）"
echo "   👉 看到 http://localhost:1455/...?code=... 的 URL 时，复制粘贴到 *本机浏览器* 打开"
echo ""
remote_interactive "${SUDO} docker exec -i -u appuser ${CONTAINER_NAME} codex login" || true

# 验证
echo ""
echo "🔍 验证登录态..."
remote "${SUDO} docker exec -u appuser ${CONTAINER_NAME} codex login status" || true

# 检查 auth.json 是否落到了挂载卷上
if [[ "${HAS_MOUNT}" -gt 0 ]]; then
  echo ""
  echo "📁 宿主机持久化目录内容:"
  remote "${SUDO} ls -la /home/${REMOTE_USER}/a2wave-data/.codex/" || true
fi
