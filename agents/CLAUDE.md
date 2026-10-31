# sagae-claude-plugins

Private Claude Code plugin marketplace (`sagae`). Pushing to `main` is a deployment: every machine with the marketplace picks it up automatically.

## Layout

- `.claude-plugin/marketplace.json`: plugin list
- `plugins/<name>/`: one plugin each, with `.claude-plugin/plugin.json`, `skills/`, `.mcp.json`
- `plugins/proxmox/server/`: Node MCP server. `pve.mjs` is the API client, `index.mjs` defines tools

## Before pushing

```sh
claude plugin validate . && claude plugin validate plugins/proxmox
(cd plugins/proxmox && npm test)
```

## Rules

- Never set `version` in `plugin.json` or `marketplace.json`. Updates are detected from the commit SHA, and a pinned version silently stops them.
- Never commit secrets. The API token lives only in `~/.config/proxmox-mcp/token`. `certs/pve-root-ca.pem` is a public CA certificate.
- The proxmox server is read-only by design: `pve.mjs` can only send GET and the token has only `PVEAuditor`. Adding write tools needs a separate decision, a separate token with a narrower role, and explicit gating for each tool. Do not widen the existing token.
- New dependencies must be in `package-lock.json`.
- User-facing docs are in Korean; code, comments, and commits are in English.
