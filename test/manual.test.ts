import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bodyModeScoreBoost,
  extractIndexedFields,
  ManualSearchIndex,
  parseApplicability,
  repairTreePath,
  stripCrossReferences,
  suppressTitleHeadings,
} from "../src/manual.js";

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
        <li><a href="${tree}Doors/">Doors</a><ul>
          <li><a href="${tree}Doors/G415/">Driver's Outside Door Handle Touch Sensor G415</a></li>
          <li><a href="${tree}Doors/Front/">Front Door</a></li>
          <li><a href="${tree}Doors/Rear/">Rear Door</a></li>
          <li><a href="${tree}Doors/Overview/">Door Overview</a></li>
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
  if (url.pathname.endsWith("/G415/")) {
    return page(
      "<h1>Driver's Outside Door Handle Touch Sensor G415</h1>" +
        "<h3>Outside Driver Door Handle Touch Sensor G415:</h3>" +
        '<p><img alt="sensor" src="/images/g415.png"></p>',
    );
  }
  if (url.pathname.endsWith("/Front/") || url.pathname.endsWith("/Rear/") ||
      url.pathname.endsWith("/Overview/")) {
    return page(
      "<h1>Door assembly</h1>" +
        "<p>The door handle touch sensor wiring runs through the harness. " +
        "See also the door handle overview for the outside assembly.</p>",
    );
  }
  if (url.pathname.endsWith("/Equal-Title-Image/")) {
    return page(
      "<h1>Access/Start Control Module J518</h1>" +
        "<h3>Access/start Control Module J518:</h3>" +
        '<p><img alt="module" src="/images/j518.png"></p>',
    );
  }
  if (url.pathname.endsWith("/Prose-Page/")) {
    return page(
      "<h1>Some Procedure</h1>" +
        "<p>Disconnect the connector and measure resistance across the terminals.</p>",
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

describe("document field extraction", () => {
  test("image_only is true for near-equal title heading shapes", () => {
    const equal = extractIndexedFields(
      "# Access/Start Control Module J518\n\n### Access/start Control Module J518:\n\n![](</images/j518.png>)\n",
      "Access/Start Control Module J518",
      ["/images/j518.png"],
    );
    expect(equal.imageOnly).toBeTrue();
    expect(equal.imageCount).toBe(1);
    expect(equal.snippetText).toBe("[image only — 1 image]");
    expect(equal.bodyText.toLowerCase()).toContain("j518");

    const nearEqual = extractIndexedFields(
      "# Driver's Outside Door Handle Touch Sensor G415\n\n" +
        "### Outside Driver Door Handle Touch Sensor G415:\n\n![](</images/g415.png>)\n",
      "Driver's Outside Door Handle Touch Sensor G415",
      ["/images/g415.png"],
    );
    expect(nearEqual.imageOnly).toBeTrue();
    expect(nearEqual.snippetText).toBe("[image only — 1 image]");
  });

  test("image_only is false when section headings are real content under a compound title", () => {
    const fields = extractIndexedFields(
      "# Removal and Installation\n\n## Removal\n\n![](</images/a.png>)\n\n" +
        "## Installation\n\n![](</images/b.png>)\n",
      "Removal and Installation",
      ["/images/a.png", "/images/b.png"],
    );
    expect(fields.imageOnly).toBeFalse();
    expect(fields.snippetText.toLowerCase()).toContain("removal");
    expect(fields.snippetText.toLowerCase()).toContain("installation");
    expect(fields.snippetText).not.toBe("[image only — 2 images]");
  });

  test("image_only is false for prose pages and uses plural image marker", () => {
    const prose = extractIndexedFields(
      "# Some Procedure\n\nDisconnect the connector and measure resistance.\n",
      "Some Procedure",
      [],
    );
    expect(prose.imageOnly).toBeFalse();
    expect(prose.snippetText).toContain("Disconnect the connector");

    const multi = extractIndexedFields(
      "# Title\n\n### Title:\n\n![](</a.png>)\n![](</b.png>)\n",
      "Title",
      ["/a.png", "/b.png"],
    );
    expect(multi.imageOnly).toBeTrue();
    expect(multi.snippetText).toBe("[image only — 2 images]");
  });

  test("strips cross-reference markup from body and snippets", () => {
    expect(stripCrossReferences("refer to --> \\[ Door Lock \\]")).toBe(
      "refer to Door Lock",
    );
    expect(
      stripCrossReferences("as described in the repair information --> \\[ Batte"),
    ).toContain("Batte");

    // Bracketed targets wrap across lines in the source markdown.
    expect(
      stripCrossReferences("Muting \\--> \\[ Multi-Pin Connector 3,\n12-Pin \\]"),
    ).toBe("Muting Multi-Pin Connector 3,\n12-Pin");
    // Bare references carry no brackets, and Turndown escapes the leading hyphen.
    expect(
      stripCrossReferences("Additional information: \\--> Owner's Manual"),
    ).toBe("Additional information: Owner's Manual");
    expect(stripCrossReferences("see the --> Operating instructions.")).toBe(
      "see the Operating instructions.",
    );

    const fields = extractIndexedFields(
      "# Page\n\nrefer to --> \\[ Door Lock \\] for more detail.\n",
      "Page",
      [],
    );
    expect(fields.bodyText).toContain("Door Lock");
    expect(fields.bodyText).not.toContain("-->");
    expect(fields.snippetText).not.toContain("\\[");
  });

  test("suppressTitleHeadings uses Jaccard near-equality, not subset", () => {
    // Jaccard 1.0 — identical token sets after normalize
    const equal = suppressTitleHeadings(
      "### Access/start Control Module J518:\n\nbody",
      "Access/Start Control Module J518",
    );
    expect(equal).not.toContain("Access/start");
    expect(equal).toContain("body");

    // Jaccard 0.875 — intersection 7, union 8
    const nearEqual = suppressTitleHeadings(
      "### Outside Driver Door Handle Touch Sensor G415:\n\n",
      "Driver's Outside Door Handle Touch Sensor G415",
    );
    expect(nearEqual.trim()).toBe("");

    // Jaccard ~0.33 — section label under a compound title must be kept
    const section = suppressTitleHeadings(
      "## Removal\n\n## Installation\n",
      "Removal and Installation",
    );
    expect(section).toContain("## Removal");
    expect(section).toContain("## Installation");
  });
});

describe("ranking helpers", () => {
  test("boosts titles that cover every query token and component codes", () => {
    const title = "Driver's Outside Door Handle Touch Sensor G415";
    expect(bodyModeScoreBoost(title, "door handle touch sensor")).toBeGreaterThan(0);
    expect(bodyModeScoreBoost(title, "door handle touch sensor g415")).toBeGreaterThan(
      bodyModeScoreBoost(title, "door handle touch sensor"),
    );
    expect(bodyModeScoreBoost("Front Door", "door handle touch sensor")).toBe(0);
  });
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

  test("orders non-applicable after applicable and filters with applicableOnly", async () => {
    const index = new ManualSearchIndex();
    const all = await index.search("http://backend", root, "J518", 20, "title");
    const filtered = await index.search(
      "http://backend",
      root,
      "J518",
      20,
      "title",
      true,
    );
    index.close();

    const firstNonApplicable = all.findIndex(
      (hit) => hit.applicability?.appliesToVehicleYear === false,
    );
    let lastApplicable = -1;
    for (let i = all.length - 1; i >= 0; i--) {
      if (all[i]?.applicability?.appliesToVehicleYear !== false) {
        lastApplicable = i;
        break;
      }
    }
    if (firstNonApplicable !== -1 && lastApplicable !== -1) {
      expect(firstNonApplicable).toBeGreaterThan(lastApplicable);
    }
    expect(
      filtered.every((hit) => hit.applicability?.appliesToVehicleYear !== false),
    ).toBeTrue();
    expect(filtered.length).toBeLessThan(all.length);
  });

  test("body mode ranks title-matching door sensor above generic door pages", async () => {
    const index = new ManualSearchIndex();
    const results = await index.search(
      "http://backend",
      root,
      "door handle touch sensor",
      20,
      "body",
    );
    index.close();

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.title).toBe(
      "Driver's Outside Door Handle Touch Sensor G415",
    );
    expect(results[0]?.image_only).toBeTrue();
    expect(results[0]?.snippet).toBe("[image only — 1 image]");
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

  test("rebuilds on schema version mismatch", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lemon-search-schema-"));
    const path = join(directory, "manual.sqlite");
    const first = new ManualSearchIndex(path);
    await first.search("http://backend", root, "J518", 5, "title");
    first.db.exec("PRAGMA user_version = 1");
    first.close();

    const second = new ManualSearchIndex(path);
    const version = second.db.query("PRAGMA user_version").get() as {
      user_version: number;
    };
    expect(version.user_version).toBe(2);
    const count = second.db
      .query("SELECT COUNT(*) AS n FROM manual_documents")
      .get() as { n: number };
    expect(count.n).toBe(0);
    second.close();
    rmSync(directory, { recursive: true });
  });

  test("schema migration leaves FTS triggers and user_version consistent", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lemon-search-schema-atomic-"));
    const path = join(directory, "manual.sqlite");
    const first = new ManualSearchIndex(path);
    await first.search("http://backend", root, "J518", 5, "title");
    first.db.exec("PRAGMA user_version = 1");
    first.close();

    const second = new ManualSearchIndex(path);
    const version = second.db.query("PRAGMA user_version").get() as {
      user_version: number;
    };
    expect(version.user_version).toBe(2);
    // Migration is transactional: new schema always has content + FTS triggers together.
    const triggers = second.db
      .query(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'manual_documents_%' ORDER BY name",
      )
      .all() as { name: string }[];
    expect(triggers.map((row) => row.name)).toEqual([
      "manual_documents_ad",
      "manual_documents_ai",
      "manual_documents_au",
    ]);
    const fts = second.db
      .query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='manual_documents_fts'",
      )
      .get() as { name: string } | null;
    expect(fts?.name).toBe("manual_documents_fts");
    // Title search must work after a version-bumped open (empty store, re-ingest).
    const results = await second.search("http://backend", root, "J518", 5, "title");
    expect(results.length).toBeGreaterThan(0);
    second.close();
    rmSync(directory, { recursive: true });
  });

  test("concurrent title searches hydrate each document once", async () => {
    requestedPaths.length = 0;
    const index = new ManualSearchIndex();
    const [a, b] = await Promise.all([
      index.search("http://backend", root, "J518", 20, "title"),
      index.search("http://backend", root, "J518", 20, "title"),
    ]);
    expect(a).toHaveLength(2);
    expect(b).toHaveLength(2);
    // Without runExclusive, both callers select body_indexed=0 and double-fetch.
    const bodyFetches = requestedPaths.filter(
      (path) =>
        path.endsWith("/J518-A/") ||
        path.endsWith("/J518-B/") ||
        path.endsWith("/J518-New/"),
    );
    expect(bodyFetches.filter((path) => path.endsWith("/J518-A/"))).toHaveLength(1);
    expect(bodyFetches.filter((path) => path.endsWith("/J518-B/"))).toHaveLength(1);
    expect(bodyFetches.filter((path) => path.endsWith("/J518-New/"))).toHaveLength(1);
    for (const result of a) {
      expect(result.snippet.length).toBeGreaterThan(0);
      expect(result.snippet).not.toBe("[No page body text is available.]");
    }
    index.close();
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
