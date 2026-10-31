#!/usr/bin/env bash
# Issues this machine's read-only PVE API token and stores it locally.
#
# Each machine has its own token, so nothing here can lock another machine out.
# Without --rotate an existing token file is kept and no remote call is made.
#
# The order never changes: issue the new token, write it to a temp file, verify
# it against /version, swap the file atomically, delete the old token. A failure
# before the swap leaves the old token and file as they were.
#
# Deletions are limited to the ID in the local token file (read from before the
# "=" only) and to a token this run issued but could not put in place. The shared
# "mcp" token is never deleted here: other machines may still depend on it.
set -euo pipefail

PVE_USER="claude-mcp@pve"
SHARED_TOKEN_ID="mcp"
# PVE's own pattern for token IDs (PVE::AccessControl::token_subid_regex).
TOKEN_ID_PATTERN='^[A-Za-z][A-Za-z0-9._-]+$'
TOKEN_LIFETIME_DAYS=365
# Same list as server/index.mjs: verification must reach the hosts the server uses.
DEFAULT_PVE_HOSTS="192.0.2.1,192.0.2.1,192.0.2.1"

PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOKEN_FILE="${PVE_TOKEN_FILE:-$HOME/.config/proxmox-mcp/token}"
CA_FILE="${PVE_CA_FILE:-$PLUGIN_ROOT/certs/pve-root-ca.pem}"

SSH_HOST="pve-node"
NEW_ID=""
ROTATE=false
KEEP_OLD=false

OLD_ID=""
TMP_FILE=""
ISSUED_ID="" # Set while the new token exists on the node but not yet in the local file.

usage() {
  cat <<EOF
Usage: bootstrap-token.sh [--host <ssh-host>] [--name <token-id>] [--rotate] [--keep-old]

  --host <ssh-host>   Node to issue the token on (default: pve-node)
  --name <token-id>   Token ID (default: m-<hostname>-<yyyymm>; rotating again
                      within a month adds -2, -3, ...)
  --rotate            Replace the token in the existing token file
  --keep-old          With --rotate, leave the old token on the node. Required
                      while the token file still holds the shared "mcp" token.
EOF
}

die() {
  echo "bootstrap-token: $*" >&2
  exit 1
}

bad_usage() {
  echo "bootstrap-token: $*" >&2
  usage >&2
  exit 2
}

# Prints the token ID from the local file, or nothing if the file does not hold
# a well-formed ID of $PVE_USER. Only the part before "=" is read, so the secret
# never enters this shell.
file_token_id() {
  local owner_id id
  owner_id=$(head -n 1 "$TOKEN_FILE" | cut -s -d= -f1) || return 0
  id=${owner_id#"$PVE_USER!"}
  if [[ $id != "$owner_id" && $id =~ $TOKEN_ID_PATTERN ]]; then
    printf '%s\n' "$id"
  fi
}

default_token_id() {
  local host base
  host=$(hostname -s 2>/dev/null || uname -n)
  host=$(printf '%s' "${host%%.*}" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-//; s/-$//')
  [[ -n $host ]] || die "Cannot derive a token ID from this hostname. Pass --name."
  base="m-$host-$(date +%Y%m)"

  # PVE refuses a duplicate ID, and the old token must outlive the new one being
  # verified, so a second rotation within a month needs an ID of its own.
  if [[ $OLD_ID == "$base" ]]; then
    printf '%s-2\n' "$base"
  elif [[ $OLD_ID =~ ^$base-([0-9]+)$ ]]; then
    printf '%s-%d\n' "$base" "$((10#${BASH_REMATCH[1]} + 1))"
  else
    printf '%s\n' "$base"
  fi
}

# Prints the new secret and nothing else on stdout. A token that cannot be completed
# is removed again, so a failure leaves no half-made token on the node.
remote_issue() {
  ssh -o BatchMode=yes -o ConnectTimeout=10 "$SSH_HOST" bash -s -- "$PVE_USER" "$1" "$2" <<'REMOTE'
set -euo pipefail
user=$1 id=$2 expire=$3

pveum user list --output-format json | grep -F "\"$user\"" >/dev/null \
  || pveum user add "$user" --comment "Claude Code MCP (read-only)" >/dev/null
pveum acl modify / --users "$user" --roles PVEAuditor >/dev/null

issued=$(pveum user token add "$user" "$id" --privsep 1 --expire "$expire" \
  --comment "Claude Code MCP" --output-format json)

if ! value=$(printf '%s' "$issued" | python3 -c 'import json,sys; print(json.load(sys.stdin)["value"])') \
  || ! pveum acl modify / --tokens "$user!$id" --roles PVEAuditor >/dev/null; then
  pveum user token remove "$user" "$id" >/dev/null || true
  exit 1
fi
printf '%s\n' "$value"
REMOTE
}

remote_remove() {
  ssh -n -o BatchMode=yes -o ConnectTimeout=10 "$SSH_HOST" pveum user token remove "$PVE_USER" "$1"
}

# Goes through the server's hosts and pinned CA, so a pass proves this machine can
# use the token. The token reaches curl on stdin to stay out of the process list.
verify_token() {
  local host
  local -a hosts
  IFS=', ' read -r -a hosts <<<"${PVE_HOSTS:-$DEFAULT_PVE_HOSTS}"
  for host in "${hosts[@]}"; do
    if printf 'header = "Authorization: PVEAPIToken=%s"\n' "$(<"$TMP_FILE")" |
      curl --silent --show-error --fail --max-time 8 --noproxy '*' --cacert "$CA_FILE" \
        --config - --output /dev/null "https://$host:8006/api2/json/version"; then
      return 0
    fi
  done
  return 1
}

cleanup() {
  local status=$?
  trap - EXIT
  rm -f "$TMP_FILE"
  if [[ -n $ISSUED_ID ]]; then
    if remote_remove "$ISSUED_ID"; then
      echo "bootstrap-token: revoked unused token $ISSUED_ID." >&2
    else
      echo "bootstrap-token: could not revoke $ISSUED_ID. Delete it with: ssh $SSH_HOST pveum user token remove $PVE_USER $ISSUED_ID" >&2
    fi
  fi
  exit "$status"
}

while (($# > 0)); do
  case "$1" in
    --host)
      (($# >= 2)) || bad_usage "--host needs a value."
      SSH_HOST=$2
      shift 2
      ;;
    --name)
      (($# >= 2)) || bad_usage "--name needs a value."
      NEW_ID=$2
      shift 2
      ;;
    --rotate)
      ROTATE=true
      shift
      ;;
    --keep-old)
      KEEP_OLD=true
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) bad_usage "Unknown argument: $1" ;;
  esac
done

# Both values reach ssh or a remote shell, so neither may carry options or syntax.
[[ $SSH_HOST =~ ^[A-Za-z0-9][A-Za-z0-9._@-]*$ ]] || bad_usage "Invalid --host: $SSH_HOST"
if [[ -n $NEW_ID ]]; then
  [[ $NEW_ID =~ $TOKEN_ID_PATTERN ]] || bad_usage "Invalid --name: $NEW_ID"
  [[ $NEW_ID != "$SHARED_TOKEN_ID" ]] || bad_usage "--name cannot be the shared \"$SHARED_TOKEN_ID\" token."
fi

if [[ -s $TOKEN_FILE ]]; then
  if ! $ROTATE; then
    echo "Token already present at $TOKEN_FILE; nothing to do. Use --rotate to replace it."
    exit 0
  fi

  OLD_ID=$(file_token_id)
  if ! $KEEP_OLD; then
    [[ -n $OLD_ID ]] || die "Cannot read a $PVE_USER token ID from $TOKEN_FILE, so nothing can be deleted safely. Re-run with --rotate --keep-old to replace the file and leave the node alone."
    [[ $OLD_ID != "$SHARED_TOKEN_ID" ]] || die "$TOKEN_FILE holds the shared \"$SHARED_TOKEN_ID\" token, which other machines may still use. Re-run with --rotate --keep-old, and remove it by hand once every machine has moved."
  fi
fi

[[ -n $NEW_ID ]] || NEW_ID=$(default_token_id)
[[ $NEW_ID != "$OLD_ID" ]] || die "$NEW_ID is the current token. Rotation needs a new ID."

# Everything that could still fail locally is checked before the node is touched.
for tool in ssh curl; do
  command -v "$tool" >/dev/null || die "$tool is required."
done
[[ -r $CA_FILE ]] || die "CA certificate not readable at $CA_FILE."

umask 077
mkdir -p "$(dirname "$TOKEN_FILE")"
TMP_FILE=$(mktemp "$TOKEN_FILE.XXXXXX")
trap cleanup EXIT

expire_at=$(($(date +%s) + TOKEN_LIFETIME_DAYS * 86400))
if ! secret=$(remote_issue "$NEW_ID" "$expire_at"); then
  die "Could not issue token $NEW_ID on $SSH_HOST. The existing token and file are unchanged. If the ID already exists, delete it on the node or pick another with --name."
fi
ISSUED_ID=$NEW_ID

[[ $secret =~ ^[0-9A-Za-z-]+$ ]] || die "$SSH_HOST returned a malformed token. The existing token and file are unchanged."
printf '%s!%s=%s\n' "$PVE_USER" "$NEW_ID" "$secret" >"$TMP_FILE"

verify_token || die "New token $NEW_ID failed verification. The existing token and file are unchanged."

mv -f "$TMP_FILE" "$TOKEN_FILE"
ISSUED_ID=""
echo "Token $PVE_USER!$NEW_ID written to $TOKEN_FILE (valid for $TOKEN_LIFETIME_DAYS days)."

if [[ -n $OLD_ID ]]; then
  if $KEEP_OLD; then
    echo "Old token $OLD_ID left on the node."
  else
    remote_remove "$OLD_ID" || die "The new token is in place, but old token $OLD_ID could not be deleted. Delete it with: ssh $SSH_HOST pveum user token remove $PVE_USER $OLD_ID"
    echo "Old token $OLD_ID deleted."
  fi
fi
