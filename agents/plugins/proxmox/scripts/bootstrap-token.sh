#!/usr/bin/env bash
# Creates a read-only PVE API token and stores it locally. Safe to re-run:
# an existing token file is kept, otherwise the token is rotated.
set -euo pipefail

SSH_HOST="${1:-pve-node}"
PVE_USER="claude-mcp@pve"
TOKEN_ID="mcp"
TOKEN_FILE="${PVE_TOKEN_FILE:-$HOME/.config/proxmox-mcp/token}"

if [[ -s "$TOKEN_FILE" ]]; then
  echo "Token already present at $TOKEN_FILE; nothing to do."
  exit 0
fi

secret=$(ssh -o BatchMode=yes "$SSH_HOST" bash -s <<EOF
set -euo pipefail
pveum user list --output-format json | grep -q '"$PVE_USER"' || pveum user add $PVE_USER --comment "Claude Code MCP (read-only)"
pveum acl modify / --users $PVE_USER --roles PVEAuditor
pveum user token remove $PVE_USER $TOKEN_ID >/dev/null 2>&1 || true
pveum user token add $PVE_USER $TOKEN_ID --privsep 1 --comment "Claude Code MCP" --output-format json \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["value"])'
pveum acl modify / --tokens '$PVE_USER!$TOKEN_ID' --roles PVEAuditor
EOF
)

mkdir -p "$(dirname "$TOKEN_FILE")"
(umask 077; printf '%s!%s=%s\n' "$PVE_USER" "$TOKEN_ID" "$secret" > "$TOKEN_FILE")
echo "Token written to $TOKEN_FILE"
