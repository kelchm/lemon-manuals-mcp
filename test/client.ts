// Exercise the MCP server end-to-end over streamable HTTP against the live
// backend: vehicle dedupe, opaque-path round trips, title search, and images.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// J518 door-handle track diagram, pinned end-to-end through the MCP transport so
// base64 round-tripping cannot silently truncate an image block.
const CANARY_IMAGE_PATH = "/images/IMP66Q313/euro600/891404313/";
const CANARY_IMAGE_BYTE_LENGTH = 22_388;
const CANARY_IMAGE_WIDTH = 1584;
const CANARY_IMAGE_HEIGHT = 2000;

interface ContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

interface SearchVehicle {
  uriPath: string;
  variants: string[];
  manuals?: { database: string; engine: string | null; uriPath: string }[];
  rootUriTable?: unknown;
  rootLinkTable?: unknown;
}

interface ManualHit {
  title: string;
  path: string;
  snippet: string;
  also_under: string[][];
  applicability?: {
    from?: string;
    through?: string;
    appliesToVehicleYear: boolean | null;
  };
}

function contentBlocks(result: unknown): ContentBlock[] {
  const content = (result as { content?: ContentBlock[] }).content;
  return content ?? [];
}

function firstText(result: unknown): string {
  return contentBlocks(result).find((block) => block.type === "text")?.text ?? "";
}

function imagePaths(markdown: string): string[] {
  return [...markdown.matchAll(/!\[[^\]]*\]\(<([^>]+)>/g)].flatMap(
    (match) => (match[1] ? [match[1]] : []),
  );
}

const PORT = 8788;
const child = spawn("bun", ["src/index.ts"], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ["ignore", "inherit", "inherit"],
});
let client: Client | undefined;

try {
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/healthz`);
      if (response.ok) break;
    } catch {
      // The child may still be loading the indexes.
    }
    if (Date.now() > deadline) throw new Error("server never became healthy");
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  client = new Client({ name: "smoke", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`)),
  );

  const tools = await client.listTools();
  const toolNames = tools.tools.map((tool) => tool.name);
  console.log("tools:", toolNames.join(", "));
  for (const expected of [
    "list_makes",
    "search_vehicles",
    "get_page",
    "search_manual",
    "get_image",
  ]) {
    assert(toolNames.includes(expected), `missing tool: ${expected}`);
  }

  const makes = firstText(
    await client.callTool({ name: "list_makes", arguments: {} }),
  );
  console.log("makes count:", (JSON.parse(makes) as unknown[]).length);

  const searchText = firstText(
    await client.callTool({
      name: "search_vehicles",
      arguments: { query: "2005 touareg", limit: 5 },
    }),
  );
  const vehicles = JSON.parse(searchText) as SearchVehicle[];
  assert(vehicles.length > 0 && vehicles.length <= 5);
  for (const vehicle of vehicles) {
    assert(Array.isArray(vehicle.variants));
    assert(!("rootUriTable" in vehicle), "rootUriTable leaked into output");
    assert(!("rootLinkTable" in vehicle), "rootLinkTable leaked into output");
    if (vehicle.manuals) {
      for (const manual of vehicle.manuals) {
        assert.deepEqual(
          Object.keys(manual).sort(),
          ["database", "engine", "uriPath"],
          "search_vehicles manuals[] must be trimmed ManualRef entries",
        );
      }
    }
  }
  console.log("deduped search '2005 touareg':", searchText.slice(0, 400));

  const root = vehicles[0]?.uriPath;
  assert(root, "no vehicle result to fetch");
  const rootPage = firstText(
    await client.callTool({
      name: "get_page",
      arguments: { path: root, depth: 1, max_bytes: 40_000 },
    }),
  );
  assert(rootPage.length > 0);
  console.log(`get_page ${root}:\n${rootPage.slice(0, 400)}`);

  const j518Root =
    process.env["SMOKE_J518_ROOT"] ??
    "/Volkswagen/2005/Touareg%20%287LA%29%20V8-4.2L%20%28BHX%29/";
  const manualSearchText = firstText(
    await client.callTool({
      name: "search_manual",
      arguments: { path: j518Root, query: "J518", mode: "title", limit: 20 },
    }),
  );
  const manualHits = JSON.parse(manualSearchText) as ManualHit[];
  assert(manualHits.length > 0, "search_manual returned no J518 titles");
  assert(manualHits.every((hit) => /j518/i.test(hit.title)));
  assert(manualHits.every((hit) => Array.isArray(hit.also_under)));
  assert(
    manualHits.every((hit) => !hit.snippet.includes(" › ")),
    "snippet still duplicates the breadcrumb",
  );
  console.log("search_manual J518:", manualSearchText.slice(0, 800));

  const firstHitPath = manualHits[0]?.path;
  assert(firstHitPath, "search_manual hit did not include a path");
  const hitPage = firstText(
    await client.callTool({
      name: "get_page",
      arguments: { path: firstHitPath, depth: 2, max_bytes: 200_000 },
    }),
  );
  assert(hitPage.length > 0, "search_manual path did not round-trip through get_page");

  let imageBlock: ContentBlock | undefined;
  const pagesToInspect = [hitPage];
  for (const hit of manualHits.slice(1, 10)) {
    if (pagesToInspect.some((page) => imagePaths(page).length > 0)) break;
    pagesToInspect.push(
      firstText(
        await client.callTool({
          name: "get_page",
          arguments: { path: hit.path, depth: 2, max_bytes: 200_000 },
        }),
      ),
    );
  }

  for (const imagePath of pagesToInspect.flatMap(imagePaths)) {
    try {
      const imageResult = await client.callTool({
        name: "get_image",
        arguments: { path: imagePath },
      });
      imageBlock = contentBlocks(imageResult).find(
        (block) => block.type === "image",
      );
      if (imageBlock) break;
    } catch {
      // Try another image if this one is over the 2 MB response limit.
    }
  }
  assert(imageBlock?.data, "no J518 page exposed a retrievable image");
  assert(imageBlock.mimeType?.startsWith("image/"));
  console.log(
    "get_image:",
    imageBlock.mimeType,
    `${Buffer.from(imageBlock.data, "base64").byteLength} bytes`,
  );

  // Canary image: pin byte length and pixel dimensions once filled from a live run.
  if (CANARY_IMAGE_BYTE_LENGTH > 0) {
    const canaryResult = await client.callTool({
      name: "get_image",
      arguments: { path: CANARY_IMAGE_PATH },
    });
    const canary = contentBlocks(canaryResult).find((block) => block.type === "image");
    assert(canary?.data, "canary get_image returned no image block");
    const canaryBytes = Buffer.from(canary.data, "base64");
    assert.equal(
      canaryBytes.byteLength,
      CANARY_IMAGE_BYTE_LENGTH,
      "canary image byte length drifted",
    );
    // PNG width/height live at offsets 16 and 20.
    if (canary.mimeType === "image/png") {
      assert.equal(canaryBytes.readUInt32BE(16), CANARY_IMAGE_WIDTH);
      assert.equal(canaryBytes.readUInt32BE(20), CANARY_IMAGE_HEIGHT);
    }
    console.log(
      "canary get_image:",
      canary.mimeType,
      `${canaryBytes.byteLength} bytes`,
      `${CANARY_IMAGE_WIDTH}x${CANARY_IMAGE_HEIGHT}`,
    );
  } else {
    console.log("canary get_image: skipped (TODO constants not pinned yet)");
  }

  const missingImage = await client.callTool({
    name: "get_image",
    arguments: { path: "/images/does-not-exist/missing.png" },
  }) as { content: ContentBlock[]; isError?: boolean };
  assert(missingImage.isError, "missing get_image should be an error result");
  const missingText = contentBlocks(missingImage).find((block) => block.type === "text")?.text ?? "";
  assert(missingText.length > 0, "missing get_image must return a text error, not an empty block");
  assert(!contentBlocks(missingImage).some((block) => block.type === "image"));
  console.log("missing get_image error:", missingText.slice(0, 200));

  const rankedRoot =
    process.env["SMOKE_J518_ROOT"] ??
    "/Volkswagen/2005/Touareg%20%287LA%29%20V8-4.2L%20%28BHX%29/";
  const rankedText = firstText(
    await client.callTool({
      name: "search_manual",
      arguments: { path: rankedRoot, query: "J518", mode: "title", limit: 50 },
    }),
  );
  const rankedHits = JSON.parse(rankedText) as ManualHit[];
  if (rankedHits.some((hit) => hit.applicability)) {
    const firstFalse = rankedHits.findIndex(
      (hit) => hit.applicability?.appliesToVehicleYear === false,
    );
    let lastTrueOrNull = -1;
    for (let i = rankedHits.length - 1; i >= 0; i--) {
      if (rankedHits[i]?.applicability?.appliesToVehicleYear !== false) {
        lastTrueOrNull = i;
        break;
      }
    }
    if (firstFalse !== -1 && lastTrueOrNull !== -1) {
      assert(
        firstFalse > lastTrueOrNull,
        "appliesToVehicleYear:true results must rank above false",
      );
    }
    console.log("J518 applicability ordering ok on", rankedRoot);
  }
} finally {
  await client?.close().catch(() => undefined);
  child.kill();
}
