import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { VehicleIndex } from "./vehicles.js";
import {
  DEFAULT_MAX_BYTES,
  fetchResolvedPage,
  TRUNCATION_MARKER,
} from "./page.js";

const MIN_MAX_BYTES = new TextEncoder().encode(`\n\n${TRUNCATION_MARKER}`).length;

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
        "Returns one result per manual with its collapsed variants and a root path for get_page. " +
        "Every path is an opaque encoded token: pass it exactly as returned and never decode it.",
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
        "Under a vehicle root, 'Repair and Diagnosis/' holds the manual tree and 'Labor Times/' the labor estimates. " +
        "Paths are opaque encoded tokens: pass them exactly as returned and never decode them.",
      inputSchema: {
        path: z
          .string()
          .describe(
            "opaque encoded site path; pass exactly as returned, never decode",
          ),
        depth: z
          .number()
          .int()
          .min(1)
          .default(1)
          .describe("directory-tree levels to include"),
        max_bytes: z
          .number()
          .int()
          .min(MIN_MAX_BYTES)
          .default(DEFAULT_MAX_BYTES)
          .describe("maximum UTF-8 bytes returned before truncation"),
      },
    },
    async ({ path, depth, max_bytes }) => {
      const page = await fetchResolvedPage(baseUrl, path, depth, max_bytes);
      return { content: [{ type: "text", text: page.markdown }] };
    },
  );

  return server;
}
