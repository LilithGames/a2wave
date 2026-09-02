# ssh-opts.sh — shared SSH host key policy for the remote helper scripts.
#
# Sourced (not executed) by scripts/deploy-remote.sh and
# scripts/codex-login-remote.sh so both reach a host under the same rules; a
# copy that drifts is a copy that quietly weakens one of them.
#
# accept-new trusts a host we have never seen and then pins it, so a later key
# change aborts the run instead of being accepted silently — which is what
# StrictHostKeyChecking=no did on every single connection, password and all.
# Either knob below closes the first-connection window as well:
#   DEPLOY_KNOWN_HOSTS_FILE  known_hosts file to verify the host against
#   DEPLOY_HOST_KEY          a known_hosts line ("<host> ssh-ed25519 AAAA…")
#
# Defines: SSH_OPTS (array, for ssh/scp) and, with DEPLOY_HOST_KEY,
# PINNED_KNOWN_HOSTS (temp file; removed by an EXIT trap the caller may replace
# as long as it keeps removing the file).

a2wave_init_ssh_opts() {
  SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o LogLevel=ERROR)
  if [[ -n "${DEPLOY_HOST_KEY:-}" ]]; then
    PINNED_KNOWN_HOSTS="$(mktemp "${TMPDIR:-/tmp}/a2wave-known-hosts.XXXXXX")"
    trap 'rm -f "${PINNED_KNOWN_HOSTS}"' EXIT
    printf '%s\n' "${DEPLOY_HOST_KEY}" > "${PINNED_KNOWN_HOSTS}"
    SSH_OPTS=(-o StrictHostKeyChecking=yes -o "UserKnownHostsFile=${PINNED_KNOWN_HOSTS}" -o LogLevel=ERROR)
  elif [[ -n "${DEPLOY_KNOWN_HOSTS_FILE:-}" ]]; then
    SSH_OPTS=(-o StrictHostKeyChecking=yes -o "UserKnownHostsFile=${DEPLOY_KNOWN_HOSTS_FILE}" -o LogLevel=ERROR)
  fi
}
