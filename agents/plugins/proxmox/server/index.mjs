#!/usr/bin/env node
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { logRequest } from "./log.mjs";
import { connectionSettings, createClient, httpsTransport, loadToken } from "./pve.mjs";
import { registerTools } from "./tools.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { hosts, caFile } = connectionSettings();

const transport = httpsTransport({ caFile });
const pve = createClient({ hosts, getToken: loadToken, transport, log: logRequest });
// The plugin cache installs each commit in a directory named after it, so there this is the commit.
const server = new McpServer({ name: "proxmox", version: basename(root) });

registerTools(server, pve);

await server.connect(new StdioServerTransport());
