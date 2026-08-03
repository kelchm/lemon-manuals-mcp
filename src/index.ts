// Streamable-HTTP MCP server (stateless: fresh McpServer+transport per
// request, shared vehicle index) — the same transport shape metamcp fronts
// for the rest of the fleet.
import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import { VehicleIndex } from "./vehicles.js";
import { buildServer } from "./server.js";
import { ManualSearchIndex } from "./manual.js";

const BASE_URL = process.env["LEMON_BASE_URL"] ?? "http://127.0.0.1:18080";
const DATA_DIR =
  process.env["LEMON_DATA_DIR"] ?? join(import.meta.dir, "..", "data");
// Local dev uses data/<db>-index.json copies; in-cluster, point these at the
// share layout (/data/lemon/index.json, /data/charm/index.json).
const INDEX_FILES = {
  lemon: process.env["LEMON_INDEX_JSON"] ?? join(DATA_DIR, "lemon-index.json"),
  charm: process.env["CHARM_INDEX_JSON"] ?? join(DATA_DIR, "charm-index.json"),
};
const PORT = Number(process.env["PORT"] ?? 8787);
const SEARCH_DB =
  process.env["LEMON_SEARCH_DB"] ?? join(DATA_DIR, "manual-search.sqlite");

console.error(
  `[lemon-mcp] loading vehicle indexes: ${INDEX_FILES.lemon}, ${INDEX_FILES.charm}`,
);
const started = Date.now();
const index = new VehicleIndex(INDEX_FILES);
mkdirSync(dirname(SEARCH_DB), { recursive: true });
const manualIndex = new ManualSearchIndex(SEARCH_DB);
console.error(
  `[lemon-mcp] ${index.size} vehicles loaded in ${Date.now() - started}ms; pages via ${BASE_URL}`,
);

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  if (url.pathname === "/healthz") {
    res.writeHead(200).end("ok");
    return;
  }
  if (url.pathname !== "/mcp") {
    res.writeHead(404).end();
    return;
  }
  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => void transport.close());
    await buildServer(index, BASE_URL, manualIndex).connect(transport);
    await transport.handleRequest(req, res);
  } catch (err) {
    console.error("[lemon-mcp] request failed:", err);
    if (!res.headersSent) res.writeHead(500).end();
  }
});

httpServer.listen(PORT, () => {
  console.error(`[lemon-mcp] streamable HTTP on http://127.0.0.1:${PORT}/mcp`);
});
