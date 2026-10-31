#!/usr/bin/env bash
# Issues the runner's own read-only PVE API token and installs it in the LXC.
# The token only exists in this shell and in the pipes that carry it: it never
# reaches the screen, a log, a local file or a command line. It is checked
# before it is installed, and any failure after issuing revokes it again.
#
# Runs on an admin machine with root SSH access to the node, after provision.sh.
# --dry-run prints the commands and runs none of them.
set -euo pipefail

PVE_USER="claude-mcp@pve"
ROLE="PVEAuditor"
EXPIRE_DAYS=180
TOKEN_DIR="/etc/proxmox-mcp"
TOKEN_FILE="$TOKEN_DIR/token"

# Every PVE node certificate lists localhost and chains to this CA.
NODE_CA="/etc/pve/pve-root-ca.pem"
NODE_API="https://localhost:8006/api2/json"

# Exits non-zero unless the token holds privileges and all of them are .Audit.
AUDIT_ONLY_CHECK='import json, sys; paths = json.load(sys.stdin)["data"]; bad = sorted({p for privs in paths.values() for p in privs if not p.endswith(".Audit")}); sys.exit(0 if paths and not bad else "token is not audit-only: " + (", ".join(bad) or "it holds no privileges"))'

SSH_CMD=(ssh -o BatchMode=yes -o ConnectTimeout=10)

NODE=""
VMID=""
SSH_HOST=""
TOKEN_ID="ci-runner-$(date +%Y%m)"
DRY_RUN=0
TOKEN_ISSUED=0
TOKEN_INSTALLED=0
FULL_TOKEN=""
STEP=0

usage() {
  cat <<'EOF'
Usage: issue-token.sh --node <pve-node> --vmid <id> [options]

Required:
  --node <name>       Proxmox node that hosts the runner LXC
  --vmid <id>         VMID of the runner LXC

Options:
  --host <ssh-host>   SSH target for the node (default: the --node value)
  --token-id <id>     Token ID, must start with ci-runner- (default: ci-runner-YYYYMM)
  --expire-days <n>   Days until the token expires (default: 180)
  --dry-run           Print the commands and run none of them
  -h, --help          Show this help
EOF
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

usage_error() {
  printf 'error: %s\n\n' "$*" >&2
  usage >&2
  exit 2
}

need_value() {
  (($# >= 2)) || usage_error "$1 needs a value"
}

parse_args() {
  while (($# > 0)); do
    case $1 in
      --node)
        need_value "$@"
        NODE=$2
        shift 2
        ;;
      --vmid)
        need_value "$@"
        VMID=$2
        shift 2
        ;;
      --host)
        need_value "$@"
        SSH_HOST=$2
        shift 2
        ;;
      --token-id)
        need_value "$@"
        TOKEN_ID=$2
        shift 2
        ;;
      --expire-days)
        need_value "$@"
        EXPIRE_DAYS=$2
        shift 2
        ;;
      --dry-run)
        DRY_RUN=1
        shift
        ;;
      -h | --help)
        usage
        exit 0
        ;;
      *)
        usage_error "unknown argument: $1"
        ;;
    esac
  done

  [[ -n $NODE ]] || usage_error "--node is required"
  [[ -n $VMID ]] || usage_error "--vmid is required"
  SSH_HOST=${SSH_HOST:-$NODE}

  [[ $NODE =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$ ]] || usage_error "invalid --node: $NODE"
  [[ $VMID =~ ^[1-9][0-9]{2,8}$ ]] || usage_error "invalid --vmid: $VMID"
  [[ $SSH_HOST =~ ^[A-Za-z0-9_][A-Za-z0-9_.@:-]*$ ]] || usage_error "invalid --host: $SSH_HOST"
  # The prefix keeps this script away from the tokens of the other machines.
  [[ $TOKEN_ID =~ ^ci-runner-[A-Za-z0-9._-]+$ ]] || usage_error "invalid --token-id: $TOKEN_ID"
  [[ $EXPIRE_DAYS =~ ^[1-9][0-9]{0,3}$ ]] || usage_error "invalid --expire-days: $EXPIRE_DAYS"
}

# Quotes words so that a POSIX shell parses them back into the same words.
shell_join() {
  local word joined="" escaped_quote="'\\''"
  for word in "$@"; do
    if [[ ! $word =~ ^[A-Za-z0-9_@%+=:,./-]+$ ]]; then
      word="'${word//\'/$escaped_quote}'"
    fi
    joined+=" $word"
  done
  printf '%s' "${joined# }"
}

# Plan and progress lines use fd 3, so capturing a command's output with $(...)
# cannot swallow them.
plan() {
  printf '%s\n' "$*" >&3
}

step() {
  STEP=$((STEP + 1))
  plan "# Step $STEP: $*"
}

ssh_node() {
  "${SSH_CMD[@]}" "$SSH_HOST" "$1"
}

on_node() {
  local remote
  remote=$(shell_join "$@")
  if ((DRY_RUN)); then
    plan "[$SSH_HOST] $remote"
    return 0
  fi
  ssh_node "$remote" </dev/null
}

# Sends one line to a node command's stdin. printf is a shell builtin, so the
# line never shows up in a process list.
send_line() {
  local line=$1 remote=$2
  if ((DRY_RUN)); then
    plan "[local] printf '%s\n' $(shell_join "$line") | [$SSH_HOST] $remote"
    return 0
  fi
  printf '%s\n' "$line" | ssh_node "$remote"
}

check_target() {
  step "Check that LXC $VMID is on this node and has the runner group"
  on_node pct exec "$VMID" -- getent group runner >/dev/null ||
    die "LXC $VMID on $NODE is missing or has no runner group. Run provision.sh first"
}

issue_token() {
  step "Issue $PVE_USER!$TOKEN_ID, expiring in $EXPIRE_DAYS days"
  local expire response
  local value_pattern='"value"[[:space:]]*:[[:space:]]*"([^"]+)"'
  expire=$(($(date +%s) + EXPIRE_DAYS * 86400))

  # A failure here leaves TOKEN_ISSUED at 0, so an existing token with this ID
  # is never revoked by mistake.
  response=$(on_node pveum user token add "$PVE_USER" "$TOKEN_ID" \
    --privsep 1 --expire "$expire" --comment "GitHub Actions runner LXC $VMID" --output-format json) ||
    die "pveum did not issue $TOKEN_ID. If that ID already exists, as on a rebuild in the month of the last issue, pass a new one with --token-id"

  if ((DRY_RUN)); then
    FULL_TOKEN="$PVE_USER!$TOKEN_ID=<secret>"
    return 0
  fi

  TOKEN_ISSUED=1
  [[ $response =~ $value_pattern ]] || die "pveum returned no token value"
  FULL_TOKEN="$PVE_USER!$TOKEN_ID=${BASH_REMATCH[1]}"
}

grant_role() {
  step "Grant $ROLE on / to the token"
  on_node pveum acl modify / --tokens "$PVE_USER!$TOKEN_ID" --roles "$ROLE"
}

check_token() {
  step "Check the token against the API before installing it"
  local curl_cmd auth="Authorization: PVEAPIToken=$FULL_TOKEN"
  curl_cmd=$(shell_join curl --fail --silent --show-error --cacert "$NODE_CA" --header @-)

  send_line "$auth" "$curl_cmd $NODE_API/version" >/dev/null
  send_line "$auth" "$curl_cmd $NODE_API/access/permissions | python3 -c $(shell_join "$AUDIT_ONLY_CHECK")"
}

install_token() {
  step "Install the token in LXC $VMID"
  local script remote mode

  # cat reads the open stdin. install would have to reopen /dev/stdin, which an
  # unprivileged LXC can refuse for a pipe owned by the host.
  script="install -d -m 750 -o root -g runner $TOKEN_DIR && (umask 077 && cat > $TOKEN_FILE.new) && chown root:runner $TOKEN_FILE.new && chmod 640 $TOKEN_FILE.new"
  remote=$(shell_join pct exec "$VMID" -- sh -c "$script")
  send_line "$FULL_TOKEN" "$remote"

  # Any failure up to the swap revokes the new token, so the previous token has
  # to stay in place until nothing else can fail.
  mode=$(on_node pct exec "$VMID" -- stat -c '%U:%G %a' "$TOKEN_FILE.new")
  ((DRY_RUN)) || [[ $mode == "root:runner 640" ]] || die "$TOKEN_FILE.new is '$mode', expected 'root:runner 640'"

  on_node pct exec "$VMID" -- mv -f "$TOKEN_FILE.new" "$TOKEN_FILE"
  TOKEN_INSTALLED=1
}

finish() {
  local revoke="pveum user token remove $PVE_USER <old-id>"
  if ((DRY_RUN)); then
    plan "# Next: revoke any previous runner token on the node with: $revoke"
    return 0
  fi
  printf 'Token %s!%s is installed at %s in LXC %s and expires in %s days.\n' \
    "$PVE_USER" "$TOKEN_ID" "$TOKEN_FILE" "$VMID" "$EXPIRE_DAYS"
  printf 'Revoke any previous runner token on the node with: %s\n' "$revoke"
}

# Runs from the EXIT trap.
# shellcheck disable=SC2317,SC2329
revoke_on_failure() {
  local status=$?
  FULL_TOKEN=""
  if ((TOKEN_ISSUED && !TOKEN_INSTALLED)); then
    printf 'Revoking %s!%s after the failure above.\n' "$PVE_USER" "$TOKEN_ID" >&2
    on_node pveum user token remove "$PVE_USER" "$TOKEN_ID" ||
      printf 'Could not revoke it. Run on the node: pveum user token remove %s %s\n' "$PVE_USER" "$TOKEN_ID" >&2
  fi
  exit "$status"
}

main() {
  parse_args "$@"
  exec 3>&1
  trap revoke_on_failure EXIT

  if ((DRY_RUN)); then
    plan "# Dry run: these commands are printed, not executed."
    plan "# [$SSH_HOST] lines run on the node through: ${SSH_CMD[*]} $SSH_HOST <command>"
  fi

  check_target
  issue_token
  grant_role
  check_token
  install_token
  finish
}

main "$@"
