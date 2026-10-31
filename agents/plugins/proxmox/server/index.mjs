#!/usr/bin/env node
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createClient, httpsTransport, loadToken } from "./pve.mjs";
import { registerTools } from "./tools.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const hosts = (process.env.PVE_HOSTS || "192.0.2.1,192.0.2.1,192.0.2.1").split(",");
const caFile = process.env.PVE_CA_FILE || join(root, "certs", "pve-root-ca.pem");

const pve = createClient({ hosts, getToken: loadToken, transport: httpsTransport({ caFile }) });
const server = new McpServer({ name: "proxmox", version: "1.0.0" });

registerTools(server, pve);

await server.connect(new StdioServerTransport());
