// Streamable-HTTP MCP server (stateless: fresh McpServer+transport per
// request, shared vehicle index) — the same transport shape metamcp fronts
// for the rest of the fleet.
import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { join } from "node:path";
import { VehicleIndex } from "./vehicles.js";
import { buildServer } from "./server.js";

const BASE_URL = process.env["LEMON_BASE_URL"] ?? "http://127.0.0.1:18080";
const DATA_DIR =
  process.env["LEMON_DATA_DIR"] ?? join(import.meta.dir, "..", "data");
const PORT = Number(process.env["PORT"] ?? 8787);

console.error(`[lemon-mcp] loading vehicle indexes from ${DATA_DIR}...`);
const started = Date.now();
const index = new VehicleIndex(DATA_DIR);
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
    await buildServer(index, BASE_URL).connect(transport);
    await transport.handleRequest(req, res);
  } catch (err) {
    console.error("[lemon-mcp] request failed:", err);
    if (!res.headersSent) res.writeHead(500).end();
  }
});

httpServer.listen(PORT, () => {
  console.error(`[lemon-mcp] streamable HTTP on http://127.0.0.1:${PORT}/mcp`);
});
