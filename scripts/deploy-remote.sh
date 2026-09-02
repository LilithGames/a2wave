#!/usr/bin/env bash
# deploy-remote.sh — 构建并部署 a2wave 到远程机器
# 用法: ./scripts/deploy-remote.sh [选项]
#
# 选项:
#   --host   <ip>       远程主机 IP（环境变量 DEPLOY_HOST，必填）
#   --user   <user>     SSH 用户名（环境变量 DEPLOY_USER，必填）
#   --port   <port>     宿主机映射端口（环境变量 DEPLOY_PORT，默认 80）
#   --pass   <pass>     SSH/sudo 密码（环境变量 DEPLOY_PASS，必填）
#   --secret <secret>   AUTH_SECRET（环境变量 DEPLOY_AUTH_SECRET，必填）
#   --admin-pass <pass> 管理员初始密码（环境变量 DEPLOY_ADMIN_PASS，必填）
#   --skip-build        跳过 Docker 镜像构建（复用本地已有 a2wave:latest）
#   --help              显示帮助
#
# 敏感信息（仅环境变量，无默认值，未设置则报错）:
#   DEPLOY_PASS         SSH/sudo 密码
#   DEPLOY_AUTH_SECRET  应用 AUTH_SECRET
#   DEPLOY_ADMIN_PASS   管理员初始密码
#
# SSH host key (optional; unset = accept-new, i.e. record on first contact, then pin):
#   DEPLOY_KNOWN_HOSTS_FILE  known_hosts file to verify the host against (strict)
#   DEPLOY_HOST_KEY          a single known_hosts line ("<host> ssh-ed25519 AAAA…")
#
# Advanced (optional):
#   DEPLOY_REMOTE_ENV_FILE   remote path for the container env file
#                            (default /home/<user>/a2wave.env; written 0600, removed after start)
#
# 企业 OIDC（可选；ISSUER + CLIENT_ID 要么全设、要么全不设，不设即不启用）:
#   DEPLOY_OIDC_ISSUER             IdP issuer（discovery = {issuer}/.well-known/openid-configuration）
#   DEPLOY_OIDC_CLIENT_ID          在 IdP 注册的 client_id
#   DEPLOY_OIDC_CLIENT_SECRET      可选：机密客户端的 secret；不设按 PKCE 公共客户端处理
#   DEPLOY_OIDC_SCOPES             可选：默认 "openid profile email"
#   DEPLOY_OIDC_CHANNEL_AUDIENCES  可选（逗号分隔）：OAuth 发布渠道接受的调用方 token aud。
#                                  不设则该渠道关闭（fail closed）；登录不受影响。

set -euo pipefail

# ── 非敏感配置（可有默认值，可被命令行覆盖）────────────────────────────────────
# 部署目标没有默认值：默认值会让脚本在未配置时连到别人的机器上。
REMOTE_HOST="${DEPLOY_HOST:-}"
REMOTE_USER="${DEPLOY_USER:-}"
HOST_PORT="${DEPLOY_PORT:-80}"
# 该脚本默认部署到 HTTP 入口（端口 80，无 HTTPS ingress），cookie 必须关 Secure，
# 否则浏览器会丢 __Host- Secure cookie，登录无限循环回 /login。详见 MR !99。
# 走 HTTPS edge 的环境用 DEPLOY_AUTH_COOKIE_SECURE=true 覆盖。
AUTH_COOKIE_SECURE="${DEPLOY_AUTH_COOKIE_SECURE:-false}"

# IdP OAuth (backend SSO login + Agent OAuth access); see docs/agent/oauth-channel.md.
# These are the IdP's public identifiers and signature-verification key (not an
# App Secret), but they carry **no defaults**: baking in one IdP's issuer/key
# would make an unconfigured deployment silently trust tokens it signed.
# ISSUER / AUDIENCES / PUBLIC_KEY go together (all set, or all empty = disabled).
# KEY_ID is optional and injected on its own — see the validation below.
OIDC_ISSUER="${DEPLOY_OIDC_ISSUER:-}"
OIDC_CLIENT_ID="${DEPLOY_OIDC_CLIENT_ID:-}"
OIDC_CLIENT_SECRET="${DEPLOY_OIDC_CLIENT_SECRET:-}"
OIDC_SCOPES="${DEPLOY_OIDC_SCOPES:-}"
OIDC_CHANNEL_AUDIENCES="${DEPLOY_OIDC_CHANNEL_AUDIENCES:-}"

# ── 敏感信息（仅环境变量，无默认值；可被 --pass/--secret/--admin-pass 覆盖）────
REMOTE_PASS="${DEPLOY_PASS:-}"
AUTH_SECRET="${DEPLOY_AUTH_SECRET:-}"
ADMIN_PASS="${DEPLOY_ADMIN_PASS:-}"

SKIP_BUILD=false
IMAGE_TAG="a2wave:latest"
TMP_IMAGE="${TMP_IMAGE:-/tmp/a2wave.tar.gz}"
DATA_DIR="/home/${REMOTE_USER}/a2wave-data"
CONTAINER_NAME="a2wave"
DOCKERFILE="Dockerfile"

# ── 参数解析 ──────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --host)       REMOTE_HOST="$2";  shift 2 ;;
    --user)       REMOTE_USER="$2";  shift 2 ;;
    --pass)       REMOTE_PASS="$2";  shift 2 ;;
    --port)       HOST_PORT="$2";    shift 2 ;;
    --secret)     AUTH_SECRET="$2";  shift 2 ;;
    --admin-pass) ADMIN_PASS="$2";   shift 2 ;;
    --skip-build) SKIP_BUILD=true;   shift ;;
    --help)
      sed -n '2,34p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *) echo "未知参数: $1"; exit 1 ;;
  esac
done

# ── Deploy target is required (no defaults — never reach an unintended host) ──
if [[ -z "${REMOTE_HOST}" ]]; then echo "❌ Set DEPLOY_HOST or pass --host"; exit 1; fi
if [[ -z "${REMOTE_USER}" ]]; then echo "❌ Set DEPLOY_USER or pass --user"; exit 1; fi

# ── Secrets are required (env var or flag; no defaults) ───────────────────────
if [[ -z "${REMOTE_PASS}" ]]; then echo "❌ Set DEPLOY_PASS or pass --pass"; exit 1; fi
if [[ -z "${AUTH_SECRET}" ]]; then echo "❌ Set DEPLOY_AUTH_SECRET or pass --secret"; exit 1; fi
if [[ -z "${ADMIN_PASS}" ]]; then echo "❌ Set DEPLOY_ADMIN_PASS or pass --admin-pass"; exit 1; fi

# ── IdP OAuth: issuer / audiences / publicKey are all-or-nothing ──────────────
# Setting only some of them yields an instance that looks configured but can
# never verify a token, so refuse to start instead.
#
# Only ISSUER + CLIENT_ID are required. SECRET is optional (a PKCE public client
# has none), SCOPES has a server-side default, and CHANNEL_AUDIENCES governs only
# the OAuth publish channel — a deployment that uses SSO login but no oauth-published
# Agent legitimately leaves it empty.
OIDC_SET_COUNT=0
for v in "${OIDC_ISSUER}" "${OIDC_CLIENT_ID}"; do
  [[ -n "$v" ]] && OIDC_SET_COUNT=$((OIDC_SET_COUNT + 1))
done
if [[ "${OIDC_SET_COUNT}" -ne 0 && "${OIDC_SET_COUNT}" -ne 2 ]]; then
  echo "❌ Incomplete OIDC config: DEPLOY_OIDC_{ISSUER,CLIENT_ID} must both be set or both be empty"
  exit 1
fi
# Guard the dependent knobs: silently ignoring them would leave the operator
# believing SSO is configured while the container gets nothing.
if [[ "${OIDC_SET_COUNT}" -eq 0 ]]; then
  for pair in "DEPLOY_OIDC_CLIENT_SECRET:${OIDC_CLIENT_SECRET}" \
              "DEPLOY_OIDC_SCOPES:${OIDC_SCOPES}" \
              "DEPLOY_OIDC_CHANNEL_AUDIENCES:${OIDC_CHANNEL_AUDIENCES}"; do
    if [[ -n "${pair#*:}" ]]; then
      echo "❌ ${pair%%:*} is set but DEPLOY_OIDC_{ISSUER,CLIENT_ID} are not"
      exit 1
    fi
  done
fi

# ── 工具检查 ──────────────────────────────────────────────────────────────────
if ! command -v sshpass &>/dev/null; then
  echo "❌ 需要 sshpass，请先安装: brew install sshpass"
  exit 1
fi
if ! command -v docker &>/dev/null; then
  echo "❌ 需要 Docker，请先安装 Docker Desktop"
  exit 1
fi

# ── SSH host key policy ───────────────────────────────────────────────────────
# accept-new trusts a host we have never seen and then pins it, so a later key
# change aborts the deploy instead of being accepted silently — which is what
# StrictHostKeyChecking=no did on every single connection, password and all.
# Either knob below closes the first-connection window as well:
#   DEPLOY_KNOWN_HOSTS_FILE  known_hosts file to verify the host against
#   DEPLOY_HOST_KEY          a known_hosts line ("<host> ssh-ed25519 AAAA…")
SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o LogLevel=ERROR)
if [[ -n "${DEPLOY_HOST_KEY:-}" ]]; then
  PINNED_KNOWN_HOSTS="$(mktemp "${TMPDIR:-/tmp}/a2wave-known-hosts.XXXXXX")"
  trap 'rm -f "${PINNED_KNOWN_HOSTS}"' EXIT
  printf '%s\n' "${DEPLOY_HOST_KEY}" > "${PINNED_KNOWN_HOSTS}"
  SSH_OPTS=(-o StrictHostKeyChecking=yes -o "UserKnownHostsFile=${PINNED_KNOWN_HOSTS}" -o LogLevel=ERROR)
elif [[ -n "${DEPLOY_KNOWN_HOSTS_FILE:-}" ]]; then
  SSH_OPTS=(-o StrictHostKeyChecking=yes -o "UserKnownHostsFile=${DEPLOY_KNOWN_HOSTS_FILE}" -o LogLevel=ERROR)
fi

# Secrets never go into a command line: `ps auxww` is readable by every local
# user on both ends. The sudo password is the first line of the remote shell's
# stdin, and sshpass takes the SSH password from the environment (-e) rather
# than from our own argv (-p).
REMOTE_PRELUDE='IFS= read -r A2WAVE_SUDO_PASS'
SUDO='printf "%s\n" "$A2WAVE_SUDO_PASS" | sudo -S -p ""'

# $1 is piped to the remote command after the sudo password line; the rest is the
# command itself. Process substitution rather than a pipe: with `pipefail`, a
# remote command that ignores stdin would otherwise fail the whole script.
remote_with_input() {
  local input="$1"
  shift
  SSHPASS="${REMOTE_PASS}" sshpass -e ssh "${SSH_OPTS[@]}" "${REMOTE_USER}@${REMOTE_HOST}" \
    "${REMOTE_PRELUDE}
$*" < <(printf '%s\n%s' "${REMOTE_PASS}" "${input}") 2>&1
}
remote() { remote_with_input "" "$@"; }
scp_upload() { SSHPASS="${REMOTE_PASS}" sshpass -e scp "${SSH_OPTS[@]}" "$@"; }

# ── 切换到项目根目录 ──────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}/.."

echo ""
echo "🚀 a2wave 远程部署"
echo "   目标: ${REMOTE_USER}@${REMOTE_HOST}:${HOST_PORT}"
echo "   镜像: ${IMAGE_TAG}"
echo ""

# ── Step 1: 构建镜像 ──────────────────────────────────────────────────────────
if [[ "$SKIP_BUILD" == "false" ]]; then
  echo "📦 [1/4] 构建 Docker 镜像（linux/amd64）..."
  docker build --platform linux/amd64 -t "${IMAGE_TAG}" -f "${DOCKERFILE}" .
  echo "✅ 镜像构建完成"
else
  echo "⏭️  [1/4] 跳过镜像构建"
fi

# ── Step 2: 导出镜像 ──────────────────────────────────────────────────────────
echo "💾 [2/4] 导出镜像到 ${TMP_IMAGE}..."
docker save "${IMAGE_TAG}" | gzip > "${TMP_IMAGE}"
SIZE=$(du -sh "${TMP_IMAGE}" | cut -f1)
echo "✅ 镜像已导出（${SIZE}）"

# ── Step 3: 确保远程有 Docker ─────────────────────────────────────────────────
echo "🔧 [3/4] 检查远程环境..."
if ! remote "${SUDO} docker --version" | grep -q "Docker version"; then
  echo "   Docker 未安装，正在安装..."
  remote "
    ${SUDO} apt-get update -q &&
    ${SUDO} apt-get install -y -q ca-certificates curl gnupg &&
    ${SUDO} install -m 0755 -d /etc/apt/keyrings &&
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | ${SUDO} gpg --dearmor -o /etc/apt/keyrings/docker.gpg &&
    ${SUDO} chmod a+r /etc/apt/keyrings/docker.gpg &&
    echo \"deb [arch=\$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \$(lsb_release -cs) stable\" | ${SUDO} tee /etc/apt/sources.list.d/docker.list > /dev/null &&
    ${SUDO} apt-get update -q &&
    ${SUDO} apt-get install -y -q docker-ce docker-ce-cli containerd.io &&
    ${SUDO} usermod -aG docker ${REMOTE_USER}
  "
  echo "✅ Docker 安装完成"
else
  echo "✅ Docker 已就绪"
fi

# Persist every Provider login in one CLI HOME. Keep the existing Claude/Cursor/Codex directories
# as nested compatibility mounts so upgrades do not require another login. The remote deployment
# user owns these private credential directories.
REMOTE_UID="$(remote "id -u")"
REMOTE_GID="$(remote "id -g")"
remote "${SUDO} install -d -m 0750 -o ${REMOTE_UID} -g ${REMOTE_GID} ${DATA_DIR} ${DATA_DIR}/skills && ${SUDO} install -d -m 0700 -o ${REMOTE_UID} -g ${REMOTE_GID} ${DATA_DIR}/cli-home ${DATA_DIR}/.claude ${DATA_DIR}/.cursor ${DATA_DIR}/.codex"

# ── Step 4: 传输并启动 ───────────────────────────────────────────────────────
echo "📤 [4/4] 传输镜像并启动容器..."

echo "   上传中..."
scp_upload "${TMP_IMAGE}" "${REMOTE_USER}@${REMOTE_HOST}:${TMP_IMAGE}"

echo "   加载镜像..."
remote "${SUDO} docker load -i ${TMP_IMAGE}"

echo "   重启容器..."
remote "${SUDO} docker rm -f ${CONTAINER_NAME} 2>/dev/null || true"

# Every value the container needs travels in an env file written over the remote
# shell's stdin, never as `-e NAME=secret` in the remote command line: argv is
# world-readable through `ps auxww`, so AUTH_SECRET and ADMIN_PASSWORD used to be
# visible to any local user on the deployment host for the life of the command.
CONTAINER_ENV=(
  "AUTH_SECRET=${AUTH_SECRET}"
  "ADMIN_PASSWORD=${ADMIN_PASS}"
  "AUTH_COOKIE_SECURE=${AUTH_COOKIE_SECURE}"
  "A2WAVE_RUN_AS_UID=${REMOTE_UID}"
  "A2WAVE_RUN_AS_GID=${REMOTE_GID}"
)

# Inject nothing when unconfigured: an empty issuer would read as a
# present-but-broken config rather than an absent one.
if [[ "${OIDC_SET_COUNT}" -eq 2 ]]; then
  CONTAINER_ENV+=(
    "A2WAVE_OIDC_ISSUER=${OIDC_ISSUER}"
    "A2WAVE_OIDC_CLIENT_ID=${OIDC_CLIENT_ID}"
  )
  # Optional knobs: only pass through what was actually supplied, so an empty
  # value never overrides an image-level default.
  if [[ -n "${OIDC_CLIENT_SECRET}" ]]; then
    CONTAINER_ENV+=("A2WAVE_OIDC_CLIENT_SECRET=${OIDC_CLIENT_SECRET}")
  fi
  if [[ -n "${OIDC_SCOPES}" ]]; then
    CONTAINER_ENV+=("A2WAVE_OIDC_SCOPES=${OIDC_SCOPES}")
  fi
  if [[ -n "${OIDC_CHANNEL_AUDIENCES}" ]]; then
    CONTAINER_ENV+=("A2WAVE_OIDC_CHANNEL_AUDIENCES=${OIDC_CHANNEL_AUDIENCES}")
  fi
fi

for proxy_name in HTTPS_PROXY HTTP_PROXY https_proxy http_proxy; do
  if [[ -n "${!proxy_name:-}" ]]; then
    CONTAINER_ENV+=( "${proxy_name}=${!proxy_name}" )
  fi
done

# One KEY=VALUE per line, verbatim: docker parses the file itself, so no shell
# ever sees these values. A newline has no representation in that format — refuse
# rather than ship a container missing half its config.
ENV_FILE_CONTENT=""
for entry in "${CONTAINER_ENV[@]}"; do
  if [[ "${entry}" == *$'\n'* ]]; then
    echo "❌ ${entry%%=*} contains a newline, which docker --env-file cannot represent"
    exit 1
  fi
  ENV_FILE_CONTENT+="${entry}"$'\n'
done

# appuser uses HOME=/home/appuser; persist it and retain the three legacy nested mounts.
REMOTE_ENV_FILE="${DEPLOY_REMOTE_ENV_FILE:-/home/${REMOTE_USER}/a2wave.env}"
DOCKER_RUN_ARGS=(
  docker run -d
  --name "${CONTAINER_NAME}"
  --restart unless-stopped
  -p "${HOST_PORT}:3502"
  -v "${DATA_DIR}:/app/data"
  -v "${DATA_DIR}/cli-home:/home/appuser"
  -v "${DATA_DIR}/.claude:/home/appuser/.claude"
  -v "${DATA_DIR}/.cursor:/home/appuser/.cursor"
  -v "${DATA_DIR}/.codex:/home/appuser/.codex"
  --env-file "${REMOTE_ENV_FILE}"
  "${IMAGE_TAG}"
)

quote_remote_arg() {
  local value=${1//\'/\'\\\'\'}
  printf "'%s'" "$value"
}

DOCKER_RUN_COMMAND=""
for arg in "${DOCKER_RUN_ARGS[@]}"; do
  DOCKER_RUN_COMMAND+="$(quote_remote_arg "$arg") "
done

# umask 077 before the file exists: docker (as root) can still read it, nobody
# else can, and it is removed as soon as the container has been created.
QUOTED_ENV_FILE="$(quote_remote_arg "${REMOTE_ENV_FILE}")"
remote_with_input "${ENV_FILE_CONTENT}" "umask 077
cat > ${QUOTED_ENV_FILE}
${SUDO} ${DOCKER_RUN_COMMAND}
run_status=\$?
rm -f ${QUOTED_ENV_FILE}
exit \$run_status"

# ── 健康检查 ──────────────────────────────────────────────────────────────────
echo ""
echo "⏳ 等待服务启动..."
for i in $(seq 1 12); do
  sleep 3
  STATUS=$(curl -s "http://${REMOTE_HOST}:${HOST_PORT}/api/health" 2>/dev/null | grep -o '"status":"[^"]*"' | cut -d'"' -f4 || true)
  if [[ "$STATUS" == "ok" ]]; then
    echo ""
    echo "✅ 部署成功！"
    echo ""
    echo "   访问地址:  http://${REMOTE_HOST}:${HOST_PORT}"
    echo "   健康检查:  http://${REMOTE_HOST}:${HOST_PORT}/api/health"
    echo "   管理员账号: admin"
    echo ""
    # 清理本地临时文件
    rm -f "${TMP_IMAGE}"
    exit 0
  fi
  echo -n "."
done

echo ""
echo "⚠️  服务可能未正常启动，查看日志："
remote "${SUDO} docker logs ${CONTAINER_NAME} --tail 20"
exit 1
