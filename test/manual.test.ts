import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  clearManualSearchCache,
  searchManual,
  singlePagePath,
} from "../src/manual.js";

const originalFetch = globalThis.fetch;
let fetchCount = 0;
const treeHtml = `
  <div class="main">
    <h1>Repair and Diagnosis (Single Page)</h1>
    <a href="../Repair%20and%20Diagnosis/">View split tree</a>
    <ul>
      <li><a name="Electrical/">Electrical</a>
        <ul><li><a name="Electrical/Starting%20System/">Starting System</a>
          <ul>
            <li><a href="Electrical/Starting%20System/Access%20Start%20Authorization%20Control%20Module%20J518/">Access Start Authorization Control Module J518</a></li>
            <li><a href="Electrical/Starting%20System/J518%20Connector/">J518 Connector Diagram</a></li>
          </ul>
        </li></ul>
      </li>
    </ul>
  <div class="theme-colors footer">footer</div>
`;
const mockFetch: typeof fetch = Object.assign(async (input: URL | RequestInfo) => {
  fetchCount += 1;
  const url = new URL(
    typeof input === "string" || input instanceof URL ? input : input.url,
  );
  if (
    url.pathname ===
    "/Volkswagen/2005/Touareg%20V6%2C%203.2%20C/Repair%20and%20Diagnosis%20%28Single%20Page%29/"
  ) {
    return new Response(treeHtml, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  return new Response("missing", { status: 404 });
}, { preconnect: originalFetch.preconnect });

beforeAll(() => {
  clearManualSearchCache();
  globalThis.fetch = mockFetch;
});

afterAll(() => {
  clearManualSearchCache();
  globalThis.fetch = originalFetch;
});

describe("searchManual", () => {
  const root = "/Volkswagen/2005/Touareg%20V6%2C%203.2%20C/";

  test("forms the single-page path without changing the vehicle root", () => {
    expect(singlePagePath(root)).toBe(
      `${root}Repair%20and%20Diagnosis%20%28Single%20Page%29/`,
    );
  });

  test("matches all query tokens against titles and returns breadcrumbs", async () => {
    const results = await searchManual(
      "http://backend",
      root,
      "control J518",
      20,
    );

    expect(results).toEqual([
      {
        title: "Access Start Authorization Control Module J518",
        path:
          `${root}Repair%20and%20Diagnosis%20%28Single%20Page%29/` +
          "Electrical/Starting%20System/Access%20Start%20Authorization%20Control%20Module%20J518/",
        snippet:
          "Electrical › Starting System › Access Start Authorization Control Module J518",
      },
    ]);
    expect(fetchCount).toBe(1);
  });

  test("uses only titles for matching and reuses the cached title list", async () => {
    const results = await searchManual(
      "http://backend",
      root,
      "electrical J518",
      20,
    );

    expect(results).toEqual([]);
    expect(fetchCount).toBe(1);
  });
});
