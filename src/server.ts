import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { VehicleIndex } from "./vehicles.js";
import { fetchPage } from "./page.js";

export function buildServer(index: VehicleIndex, baseUrl: string): McpServer {
  const server = new McpServer({ name: "lemon-manuals", version: "0.1.0" });

  server.registerTool(
    "list_makes",
    {
      description:
        "List every car make in the LEMON (1960-2025) and CHARM (1982-2013) repair-manual databases, " +
        "with vehicle counts and covered year ranges.",
      inputSchema: {},
    },
    () => ({
      content: [{ type: "text", text: JSON.stringify(index.makes, null, 1) }],
    }),
  );

  server.registerTool(
    "search_vehicles",
    {
      description:
        "Find vehicles by free-text query over make, model, engine/trim, and year " +
        "(e.g. '2019 civic', 'miata 1994', 'f-150 5.0L 2021'). Every word must match. " +
        "Returns manual root paths for use with get_page.",
      inputSchema: {
        query: z.string().describe("words to match, order-independent"),
        limit: z.number().int().min(1).max(100).default(20),
      },
    },
    ({ query, limit }) => {
      const results = index.search(query, limit);
      return {
        content: [
          {
            type: "text",
            text:
              results.length === 0
                ? "No vehicles matched. Try fewer or different words (e.g. drop trim level)."
                : JSON.stringify(results, null, 1),
          },
        ],
      };
    },
  );

  server.registerTool(
    "get_page",
    {
      description:
        "Fetch a manual page or directory listing by site path and return it as markdown. " +
        "Start from a search_vehicles uriPath; directory pages list child links to follow. " +
        "Under a vehicle root, 'Repair and Diagnosis/' holds the manual tree and 'Labor Times/' the labor estimates.",
      inputSchema: {
        path: z
          .string()
          .describe("site path, e.g. /Honda/2025/Accord%20Hybrid%20EX-L/"),
      },
    },
    async ({ path }) => {
      const page = await fetchPage(baseUrl, path);
      return { content: [{ type: "text", text: page.markdown }] };
    },
  );

  return server;
}
