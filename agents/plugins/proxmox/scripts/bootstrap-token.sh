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
# Deletions are limited to a token this run issued but could not put in place, and
# to the ID in the local token file (read from before the "=" only), which must be
# named after this machine. The shared "mcp" token and a file copied from elsewhere
# name tokens that others may still depend on, so those are never deleted here.
# Neither is an ID this run has no proof of making: if the connection is lost during
# the issue, the script names the ID to check by hand.
set -euo pipefail

PVE_USER="claude-mcp@pve"
SHARED_TOKEN_ID="mcp"
# PVE's own pattern for token IDs (PVE::AccessControl::token_subid_regex).
TOKEN_ID_PATTERN='^[A-Za-z][A-Za-z0-9._-]+$'
# What default_token_id adds to a second ID in a month. It is kept short enough that a
# machine named box cannot claim m-box-202611-202611, the ID of a machine named box-202611.
ROTATION_COUNT='[1-9][0-9]{0,3}'
TOKEN_LIFETIME_DAYS=365
# Same list as server/pve.mjs: verification must reach the hosts the server uses.
DEFAULT_PVE_HOSTS="192.0.2.1,192.0.2.1,192.0.2.1"
# These end a dead connection, because an interrupt waits for the ssh in progress. They do not end a
# node command that blocks: sshd goes on answering keepalives, and a terminal's Ctrl-C ends that one.
SSH_OPTIONS=(-o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=3)

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
UNDELETED_ID="" # Set from the swap until the old token is known to be gone from the node.
HOLD_SIGNALS=false
HELD_STATUS=0

usage() {
  cat <<EOF
Usage: bootstrap-token.sh [--host <ssh-host>] [--name <token-id>] [--rotate] [--keep-old]

  --host <ssh-host>   Node to issue the token on (default: pve-node)
  --name <token-id>   Token ID (default: m-<hostname>-<yyyymm>; rotating again
                      within a month adds -2, -3, ...)
  --rotate            Replace the token in the existing token file
  --keep-old          With --rotate, leave the old token on the node. Required
                      while the token file holds the shared "mcp" token or an ID
                      not named after this machine.
EOF
}

# The hold comes first: a signal between here and the cleanup taking over would end the cleanup early.
die() {
  HOLD_SIGNALS=true
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

# This machine's name as it appears in a token ID. Empty if the hostname has no
# usable characters.
machine_name() {
  local host
  host=$(hostname -s 2>/dev/null || uname -n)
  printf '%s' "${host%%.*}" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-//; s/-$//'
}

# True for the IDs default_token_id gives this machine. The name is all a token file
# has to go on, so a file copied from another machine fails here, and so does an ID
# chosen with --name.
is_own_token_id() {
  local host
  host=$(machine_name)
  [[ -n $host && $1 =~ ^m-$host-[0-9]{6}(-$ROTATION_COUNT)?$ ]]
}

default_token_id() {
  local host base
  host=$(machine_name)
  [[ -n $host ]] || die "Cannot derive a token ID from this hostname. Pass --name."
  base="m-$host-$(date +%Y%m)"

  # PVE refuses a duplicate ID, and the old token must outlive the new one being
  # verified, so a second rotation within a month needs an ID of its own.
  if [[ $OLD_ID == "$base" ]]; then
    printf '%s-2\n' "$base"
  elif [[ $OLD_ID =~ ^$base-($ROTATION_COUNT)$ ]]; then
    printf '%s-%d\n' "$base" "$((10#${BASH_REMATCH[1]} + 1))"
  else
    printf '%s\n' "$base"
  fi
}

# Prints the new secret and nothing else on stdout. The node removes a token it cannot
# finish or hand over, which covers a client that is already gone. A reply lost on its
# way back cannot be seen from there, so the caller has to report that case.
remote_issue() {
  ssh "${SSH_OPTIONS[@]}" "$SSH_HOST" bash -s -- "$PVE_USER" "$1" "$2" <<'REMOTE'
set -euo pipefail
user=$1 id=$2 expire=$3

pveum user list --output-format json | grep -F "\"$user\"" >/dev/null \
  || pveum user add "$user" --comment "Claude Code MCP (read-only)" >/dev/null
pveum acl modify / --users "$user" --roles PVEAuditor >/dev/null

issued=$(pveum user token add "$user" "$id" --privsep 1 --expire "$expire" \
  --comment "Claude Code MCP" --output-format json)

# Armed only now: a refused add may mean the ID is someone else's token.
delivered=false
trap '$delivered || pveum user token remove "$user" "$id" >/dev/null 2>&1' EXIT

value=$(printf '%s' "$issued" | python3 -c 'import json,sys; print(json.load(sys.stdin)["value"])')
pveum acl modify / --tokens "$user!$id" --roles PVEAuditor >/dev/null
printf '%s\n' "$value"
delivered=true
REMOTE
}

remote_remove() {
  ssh -n "${SSH_OPTIONS[@]}" "$SSH_HOST" pveum user token remove "$PVE_USER" "$1"
}

# Goes through the server's hosts and pinned CA, so a pass proves this machine can
# use the token. The token reaches curl on stdin to stay out of the process list.
# -q has to come first: it keeps out ~/.curlrc, where "insecure" would undo --cacert.
# --capath replaces the built-in CA directory, which curl keeps trusting next to
# --cacert. The server trusts the pinned CA alone, so verification has to as well.
verify_token() {
  local host
  local -a hosts
  IFS=', ' read -r -a hosts <<<"${PVE_HOSTS:-$DEFAULT_PVE_HOSTS}"
  for host in "${hosts[@]}"; do
    if printf 'header = "Authorization: PVEAPIToken=%s"\n' "$(<"$TMP_FILE")" |
      curl -q --silent --show-error --fail --max-time 8 --noproxy '*' \
        --cacert "$CA_FILE" --capath "$PLUGIN_ROOT/certs" \
        --config - --output /dev/null "https://$host:8006/api2/json/version"; then
      return 0
    fi
  done
  return 1
}

# bash runs a signal handler between commands, so the ssh or curl in progress finishes
# first. While HOLD_SIGNALS is true the exit also waits for release_signals, which
# keeps a step together with the record of how it went.
on_signal() {
  if $HOLD_SIGNALS; then
    HELD_STATUS=$1
  else
    HOLD_SIGNALS=true
    exit "$1"
  fi
}

# Looks twice, because a signal can land between the first look and the end of the hold.
release_signals() {
  ((HELD_STATUS == 0)) || exit "$HELD_STATUS"
  HOLD_SIGNALS=false
  ((HELD_STATUS == 0)) || on_signal "$HELD_STATUS"
}

cleanup() {
  local status=$?
  HOLD_SIGNALS=true
  trap - EXIT
  rm -f "$TMP_FILE"
  if [[ -n $ISSUED_ID ]]; then
    if remote_remove "$ISSUED_ID"; then
      echo "bootstrap-token: revoked unused token $ISSUED_ID." >&2
    else
      echo "bootstrap-token: could not revoke $ISSUED_ID. Delete it with: ssh $SSH_HOST pveum user token remove $PVE_USER $ISSUED_ID" >&2
    fi
  fi
  if [[ -n $UNDELETED_ID ]]; then
    echo "bootstrap-token: The new token is in place, but old token $UNDELETED_ID may still be on the node. Delete it with: ssh $SSH_HOST pveum user token remove $PVE_USER $UNDELETED_ID" >&2
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
    is_own_token_id "$OLD_ID" || die "$TOKEN_FILE holds $OLD_ID, which is not named after this machine, so it may belong to another one. Re-run with --rotate --keep-old to replace the file and leave the node alone, and remove the old token by hand if it is unused."
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
trap cleanup EXIT
trap 'on_signal 129' HUP
trap 'on_signal 130' INT
trap 'on_signal 143' TERM
TMP_FILE=$(mktemp "$TOKEN_FILE.XXXXXX")

expire_at=$(($(date +%s) + TOKEN_LIFETIME_DAYS * 86400))

# Held so a reply that arrives always gets recorded. Only a reply holding a token proves
# this run made it, not a clean exit: the ID may be older, and may be another machine's,
# so without one it is named here and never deleted.
HOLD_SIGNALS=true
if ! secret=$(remote_issue "$NEW_ID" "$expire_at"); then
  die "Could not issue token $NEW_ID on $SSH_HOST. The existing token and file are unchanged. The ID may exist on the node if it was there already or the connection was lost after the node made it. Check with: ssh $SSH_HOST pveum user token list $PVE_USER. If it is this machine's leftover, delete it with: ssh $SSH_HOST pveum user token remove $PVE_USER $NEW_ID. Otherwise pick another ID with --name."
fi
if [[ ! $secret =~ ^[0-9A-Za-z-]+$ ]]; then
  die "$SSH_HOST returned a malformed token, so nothing shows that this run made $NEW_ID. The existing token and file are unchanged. Check with: ssh $SSH_HOST pveum user token list $PVE_USER. If it is this machine's leftover, delete it with: ssh $SSH_HOST pveum user token remove $PVE_USER $NEW_ID."
fi
ISSUED_ID=$NEW_ID
release_signals

printf '%s!%s=%s\n' "$PVE_USER" "$NEW_ID" "$secret" >"$TMP_FILE"

verify_token || die "New token $NEW_ID failed verification. The existing token and file are unchanged."

# Held so the file and ISSUED_ID change together: an exit in between would revoke the
# token now in the file. A killed mv may have renamed already, which the temp file shows.
HOLD_SIGNALS=true
mv -f "$TMP_FILE" "$TOKEN_FILE" || [[ ! -e $TMP_FILE ]] || die "Could not move the new token to $TOKEN_FILE. The existing token and file are unchanged."
ISSUED_ID=""
$KEEP_OLD || UNDELETED_ID=$OLD_ID
echo "Token $PVE_USER!$NEW_ID written to $TOKEN_FILE (valid for $TOKEN_LIFETIME_DAYS days)."
release_signals

if [[ -n $UNDELETED_ID ]]; then
  if removal=$(remote_remove "$UNDELETED_ID" 2>&1); then
    echo "Old token $OLD_ID deleted."
  elif [[ $removal == *"no such token"* ]]; then
    # The 401 advice brings people here once a token is revoked, so this is the goal reached.
    echo "Old token $OLD_ID was already gone from the node."
  else
    printf '%s\n' "$removal" >&2
    exit 1
  fi
  UNDELETED_ID=""
elif [[ -n $OLD_ID ]]; then
  echo "Old token $OLD_ID left on the node."
fi
