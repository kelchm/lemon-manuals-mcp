// Exercise the MCP server end-to-end over streamable HTTP: spawn the server,
// then walk list_makes -> search_vehicles -> get_page against the live backend.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { spawn } from "node:child_process";

const PORT = 8788;
const child = spawn("bun", ["src/index.ts"], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ["ignore", "inherit", "inherit"],
});
try {
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/healthz`);
      if (r.ok) break;
    } catch {
      if (Date.now() > deadline) throw new Error("server never became healthy");
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  const client = new Client({ name: "smoke", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`)),
  );

  const tools = await client.listTools();
  console.log("tools:", tools.tools.map((t) => t.name).join(", "));

  const first = (r: unknown): string => {
    const c = (r as { content?: { type: string; text?: string }[] }).content;
    return c?.[0]?.text ?? "";
  };

  const makes = first(
    await client.callTool({ name: "list_makes", arguments: {} }),
  );
  console.log("makes count:", (JSON.parse(makes) as unknown[]).length);

  const search = first(
    await client.callTool({
      name: "search_vehicles",
      arguments: { query: "2019 civic", limit: 3 },
    }),
  );
  console.log("search '2019 civic':", search.slice(0, 300));

  const vehicles = JSON.parse(search) as { uriPath: string }[];
  const root = vehicles[0]?.uriPath;
  if (!root) throw new Error("no search result to fetch");
  const page = first(
    await client.callTool({ name: "get_page", arguments: { path: root } }),
  );
  console.log(`get_page ${root}:\n${page.slice(0, 400)}`);

  await client.close();
} finally {
  child.kill();
}
