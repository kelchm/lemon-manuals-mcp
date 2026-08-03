import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { VehicleIndex } from "./vehicles.js";
import {
  DEFAULT_MAX_BYTES,
  fetchImage,
  fetchResolvedPage,
  TRUNCATION_MARKER,
} from "./page.js";
import { ManualSearchIndex } from "./manual.js";
import { errorDetail, publicMessage } from "./errors.js";

const MIN_MAX_BYTES = new TextEncoder().encode(`\n\n${TRUNCATION_MARKER}`).length;

function toolFailure(tool: string, error: unknown, fallback: string) {
  console.error(`[lemon-mcp] ${tool} failed: ${errorDetail(error)}`);
  return {
    content: [{ type: "text" as const, text: publicMessage(error, fallback) }],
    isError: true as const,
  };
}

export function buildServer(
  index: VehicleIndex,
  baseUrl: string,
  manualIndex = new ManualSearchIndex(),
): McpServer {
  const server = new McpServer({ name: "lemon-manuals", version: "0.3.0" });

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
        "Returns one result per physical drivetrain where it can be identified, preferring CHARM as the primary path. " +
        "The databases and manuals fields identify every LEMON/CHARM source and path in the group. " +
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
        "depth defaults to 1 and listings include immediate child counts; max_bytes defaults to 40000. " +
        "Under a vehicle root, 'Repair and Diagnosis/' holds the manual tree and 'Parts and Labor/' holds parts and labor information. " +
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
      try {
        const page = await fetchResolvedPage(baseUrl, path, depth, max_bytes);
        return { content: [{ type: "text" as const, text: page.markdown }] };
      } catch (error) {
        return toolFailure("get_page", error, "The manual page could not be fetched.");
      }
    },
  );

  server.registerTool(
    "search_manual",
    {
      description:
        "Search one vehicle manual's titles, body text, or both using a persistent full-text index. " +
        "mode defaults to both; every normalized query token must match, so a page missing any token is excluded; " +
        "drop tokens to broaden a search that returns []. " +
        "The first search of an unindexed manual may take time while its split tree and page bodies are ingested. " +
        "Results are unique documents: duplicate placements appear in also_under; snippet is body prose or " +
        "'[image only — N images]' when the page has images but no remaining prose; applicability labels are parsed when present. " +
        "Set applicable_only to true to drop results whose applicability.appliesToVehicleYear is false. " +
        "Use a vehicle root uriPath from search_vehicles. Paths are opaque encoded tokens: " +
        "pass them exactly as returned and never decode them.",
      inputSchema: {
        path: z
          .string()
          .describe(
            "opaque encoded vehicle root uriPath from search_vehicles; pass exactly as returned, never decode",
          ),
        query: z.string().min(1).describe("tokens to match"),
        mode: z
          .enum(["title", "body", "both"])
          .default("both")
          .describe("fields to search"),
        limit: z.number().int().min(1).max(100).default(20),
        applicable_only: z
          .boolean()
          .default(false)
          .describe(
            "when true, omit results with applicability.appliesToVehicleYear === false",
          ),
      },
    },
    async ({ path, query, mode, limit, applicable_only }) => {
      try {
        const results = await manualIndex.search(
          baseUrl,
          path,
          query,
          limit,
          mode,
          applicable_only,
        );
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(results, null, 1) },
          ],
        };
      } catch (error) {
        return toolFailure(
          "search_manual",
          error,
          "Manual search is temporarily unavailable.",
        );
      }
    },
  );

  server.registerTool(
    "get_image",
    {
      description:
        "Fetch an image path returned by get_page and return a validated MCP image block. " +
        "Images over 2 MB are rejected explicitly and are never truncated. " +
        "Paths are opaque encoded tokens: pass them exactly as returned and never decode them.",
      inputSchema: {
        path: z
          .string()
          .describe(
            "opaque encoded image path; pass exactly as returned, never decode",
          ),
      },
    },
    async ({ path }) => {
      try {
        const image = await fetchImage(baseUrl, path);
        return {
          content: [
            {
              type: "image" as const,
              data: image.data,
              mimeType: image.mimeType,
            },
          ],
        };
      } catch (error) {
        return toolFailure("get_image", error, "The image could not be fetched.");
      }
    },
  );

  return server;
}
