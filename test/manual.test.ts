import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManualSearchIndex, parseApplicability, repairTreePath } from "../src/manual.js";

const originalFetch = globalThis.fetch;
const requestedPaths: string[] = [];

function page(body: string): Response {
  return new Response(
    `<div class="main">${body}<div class="theme-colors footer">footer</div>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

function treeHtml(root: string): string {
  const tree = repairTreePath(root);
  return `
    <h1>Repair and Diagnosis</h1>
    <ul>
      <li><a href="${tree}Electrical/">Electrical</a><ul>
        <li><a href="${tree}Electrical/Through%2011.06/">Immobilizer, Through 11.06</a><ul>
          <li><a href="${tree}Electrical/Through%2011.06/J518-A/">Access/Start Authorization Control Module J518</a></li>
        </ul></li>
        <li><a href="${tree}Electrical/Convenience/">Convenience Systems</a><ul>
          <li><a href="${tree}Electrical/Convenience/J518-B/">Access/Start Authorization Control Module J518</a></li>
        </ul></li>
        <li><a href="${tree}Electrical/From%2012.06/">Immobilizer, From 12.06</a><ul>
          <li><a href="${tree}Electrical/From%2012.06/J518-New/">J518 Replacement</a></li>
        </ul></li>
        <li><a href="${tree}Suspension/">Suspension</a><ul>
          <li><a href="${tree}Suspension/Lower%20Arm/">Front Lower Control Arm</a></li>
        </ul></li>
      </ul></li>
    </ul>`;
}

const mockFetch: typeof fetch = Object.assign(async (input: URL | RequestInfo) => {
  const url = new URL(
    typeof input === "string" || input instanceof URL ? input : input.url,
  );
  requestedPaths.push(url.pathname);
  if (url.pathname.startsWith("/Missing/")) {
    return new Response("missing", { status: 404 });
  }
  if (url.pathname.endsWith("/Repair%20and%20Diagnosis/")) {
    const root = url.pathname.slice(0, -"Repair%20and%20Diagnosis/".length);
    return page(treeHtml(root));
  }
  if (url.pathname.endsWith("/J518-A/") || url.pathname.endsWith("/J518-B/")) {
    return page(
      "<h1>Access/Start Authorization Control Module J518</h1>" +
        "<p>Disconnect the battery, then remove the authorization module.</p>",
    );
  }
  if (url.pathname.endsWith("/J518-New/")) {
    return page("<h1>J518 Replacement</h1><p>Perform guided immobilizer adaptation.</p>");
  }
  if (url.pathname.endsWith("/Lower%20Arm/")) {
    return page(
      "<h1>Front Lower Control Arm</h1>" +
        "<p>Tighten the inner mounting bolt to the specified torque with the vehicle at curb height.</p>",
    );
  }
  return new Response("missing", { status: 404 });
}, { preconnect: originalFetch.preconnect });

beforeAll(() => {
  globalThis.fetch = mockFetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

describe("ManualSearchIndex", () => {
  const root = "/Volkswagen/2005/Touareg%20%287LA%29%20V8-4.2L%20%28BHX%29/";

  test("uses the split tree, deduplicates documents, and returns body snippets", async () => {
    requestedPaths.length = 0;
    const index = new ManualSearchIndex();
    const results = await index.search("http://backend", root, "J518", 20, "title");
    index.close();

    expect(results).toHaveLength(2);
    const duplicate = results.find((result) =>
      result.snippet.startsWith("Disconnect the battery"));
    expect(duplicate?.also_under).toHaveLength(1);
    expect(duplicate?.also_under[0]).toContain("Convenience Systems");
    expect(duplicate?.applicability).toEqual({
      through: "2006-11",
      appliesToVehicleYear: true,
    });
    expect(requestedPaths.some((path) => path.includes("Single%20Page"))).toBeFalse();
  });

  test("searches body text and tags out-of-range procedures", async () => {
    const index = new ManualSearchIndex();
    const bodyResults = await index.search(
      "http://backend",
      root,
      "specified torque",
      20,
      "body",
    );
    const future = await index.search("http://backend", root, "replacement", 20, "title");
    index.close();

    expect(bodyResults).toHaveLength(1);
    expect(bodyResults[0]?.title).toBe("Front Lower Control Arm");
    expect(future[0]?.applicability).toEqual({
      from: "2006-12",
      appliesToVehicleYear: false,
    });
  });

  test("persists indexed titles and bodies across server restarts", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lemon-search-persistence-"));
    const path = join(directory, "manual.sqlite");
    requestedPaths.length = 0;
    const first = new ManualSearchIndex(path);
    await first.search("http://backend", root, "specified torque", 20, "body");
    first.close();
    const fetchesAfterIngest = requestedPaths.length;

    const second = new ManualSearchIndex(path);
    const results = await second.search(
      "http://backend",
      root,
      "specified torque",
      20,
      "body",
    );
    second.close();
    expect(results).toHaveLength(1);
    expect(requestedPaths).toHaveLength(fetchesAfterIngest);
    rmSync(directory, { recursive: true });
  });

  test("returns clean search-unavailable errors when the split tree is missing", async () => {
    const index = new ManualSearchIndex();
    await expect(
      index.search("http://backend", "/Missing/2005/Manual/", "J518", 20, "title"),
    ).rejects.toThrow("Title search is unavailable for this manual.");
    index.close();
  });

  test("covers at least one complete-shaped vehicle per corpus per decade", async () => {
    const samples = [
      ["lemon", 1960], ["lemon", 1970], ["lemon", 1980],
      ["lemon", 1990], ["lemon", 2000], ["lemon", 2010], ["lemon", 2020],
      ["charm", 1982], ["charm", 1990], ["charm", 2000], ["charm", 2010],
    ] as const;
    const index = new ManualSearchIndex();
    for (const [database, year] of samples) {
      const sampleRoot = `/Regression/${year}/${database}%2Fsample/`;
      const results = await index.search(
        "http://backend",
        sampleRoot,
        "lower control",
        1,
        "title",
      );
      expect(results, `${database} ${year}`).toHaveLength(1);
    }
    index.close();
  });
});

test("applicability parser supports month/year and model-year forms", () => {
  expect(parseApplicability("From MY 2007 through 11.09")).toEqual({
    from: "2007",
    through: "2009-11",
  });
});
