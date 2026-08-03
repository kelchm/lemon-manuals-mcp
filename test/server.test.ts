import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../src/server.js";
import { VehicleIndex } from "../src/vehicles.js";

const validPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const originalFetch = globalThis.fetch;
const fixtureDir = mkdtempSync(join(tmpdir(), "lemon-server-test-"));
writeFileSync(join(fixtureDir, "lemon.json"), JSON.stringify({
  database: "lemon",
  vehicles: [],
}));
writeFileSync(join(fixtureDir, "charm.json"), JSON.stringify({
  database: "charm",
  vehicles: [],
}));

beforeAll(() => {
  globalThis.fetch = Object.assign(async (input: URL | RequestInfo) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
    );
    if (url.pathname === "/known.png") {
      return new Response(validPng, {
        headers: { "content-type": "image/png" },
      });
    }
    return new Response("missing", { status: 404 });
  }, { preconnect: originalFetch.preconnect });
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  rmSync(fixtureDir, { recursive: true });
});

describe("MCP tool boundary", () => {
  test("round-trips a valid image block and sanitizes upstream errors", async () => {
    const index = new VehicleIndex({
      lemon: join(fixtureDir, "lemon.json"),
      charm: join(fixtureDir, "charm.json"),
    });
    const server = buildServer(index, "http://internal.svc.cluster.local:8080");
    const client = new Client({ name: "test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const image = await client.callTool({
        name: "get_image",
        arguments: { path: "/known.png" },
      }) as { content: { type: string; data?: string; mimeType?: string }[] };
      expect(image.content[0]?.type).toBe("image");
      expect(image.content[0]?.mimeType).toBe("image/png");
      expect(Buffer.from(image.content[0]?.data ?? "", "base64")).toEqual(validPng);

      const missing = await client.callTool({
        name: "get_page",
        arguments: { path: "/missing/" },
      }) as { content: { type: string; text?: string }[]; isError?: boolean };
      expect(missing.isError).toBeTrue();
      expect(missing.content[0]?.text).not.toContain("svc.cluster.local");
      expect(missing.content[0]?.text).toContain("upstream returned 404");

      const tools = await client.listTools();
      const getPage = tools.tools.find((tool) => tool.name === "get_page");
      expect(getPage?.description).toContain("Parts and Labor");
      expect(getPage?.description).not.toContain("Labor Times");
    } finally {
      await client.close();
      await server.close();
    }
  });
});
