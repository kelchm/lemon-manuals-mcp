import { afterAll, describe, expect, test } from "bun:test";
import {
  convertHtmlToMarkdown,
  fetchImage,
  fetchResolvedPage,
  MAX_IMAGE_BYTES,
  normalizeSitePath,
  truncateMarkdown,
  TRUNCATION_MARKER,
} from "../src/page.js";

const requestedPaths: string[] = [];
const validPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const largeImage = new Uint8Array(MAX_IMAGE_BYTES + 1);
largeImage.set(validPng.subarray(0, 8));
const originalFetch = globalThis.fetch;
const mockFetch: typeof fetch = Object.assign(async (input: URL | RequestInfo) => {
  const url = new URL(
    typeof input === "string" || input instanceof URL ? input : input.url,
  );
  requestedPaths.push(`${url.pathname}${url.search}`);
  if (url.pathname === "/manual/a%2Fb/") {
    return new Response(
      '<div class="main"><a href="Target%2FPage/">Continue</a>' +
        '<div class="theme-colors footer">footer</div>',
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }
  if (url.pathname === "/manual/a%2Fb/Target%2FPage/") {
    return new Response(
      '<div class="main"><h1>Resolved</h1><p>Target body.</p>' +
        '<div class="theme-colors footer">footer</div>',
      { headers: { "content-type": "text/html" } },
    );
  }
  if (url.pathname === "/image%2Fsmall.png") {
    return new Response(validPng, {
      headers: { "content-type": "image/png" },
    });
  }
  if (url.pathname === "/image%2Flarge.png") {
    return new Response(largeImage, {
      headers: { "content-type": "image/png" },
    });
  }
  if (url.pathname === "/image%2Fbroken.png") {
    return new Response(new Uint8Array([137, 80, 78, 71]), {
      headers: { "content-type": "image/png" },
    });
  }
  if (url.pathname === "/not-an-image") {
    return new Response("manual", {
      headers: { "content-type": "text/plain" },
    });
  }
  return new Response("missing", { status: 404 });
}, { preconnect: originalFetch.preconnect });
globalThis.fetch = mockFetch;
const baseUrl = "http://backend";

afterAll(() => {
  globalThis.fetch = originalFetch;
});

describe("page conversion", () => {
  test("normalizes links, preserves encoded slashes, annotates scope, and prunes trees", () => {
    const html = String.raw`
      <h1>Diagram 32\6</h1>
      <ul>
        <li><img class="folder-icon" src="/icons/folder.svg">
          <a name="Child%20A/">System from 05.10</a>
          <ul>
            <li><a href="Deep%2FNode/">Diagram 32\6</a></li>
            <li><a href="/hyperlink/Volkswagen/X%2FY/">Through MY 2012</a></li>
          </ul>
        </li>
        <li><a href="Sibling/">Sibling</a></li>
      </ul>
      <img alt="view" src="../images/a%2Fb.png">
    `;
    const result = convertHtmlToMarkdown(
      html,
      "http://backend/Vehicle/Repair%20and%20Diagnosis/",
      1,
    );

    expect(result.markdown).toContain("# Diagram 32\\6");
    expect(result.markdown).not.toContain("Diagram 32\\\\6");
    expect(result.markdown).toContain("⚠ applicability: from 05.10");
    expect(result.markdown).toContain("(2 children)");
    expect(result.markdown).not.toContain("Deep%2FNode");
    expect(result.markdown).not.toContain("folder.svg");
    expect(result.links[1]?.path).toBe(
      "/Vehicle/Repair%20and%20Diagnosis/Deep%2FNode/",
    );
    expect(result.links[2]).toEqual({
      title: "Through MY 2012",
      path: "/Volkswagen/X%2FY/",
      breadcrumb: ["System from 05.10", "Through MY 2012"],
      childCount: 0,
    });
    expect(result.imagePaths).toEqual(["/Vehicle/images/a%2Fb.png"]);
  });

  test("resolves ordinary relative links without decoding opaque segments", () => {
    expect(
      normalizeSitePath("../X%2FY/", "http://backend/A/B%2FC/Page/"),
    ).toBe("/A/B%2FC/X%2FY/");
  });

  test("truncates on a UTF-8 boundary and retains the marker", () => {
    const truncated = truncateMarkdown("é".repeat(100), 100);
    expect(Buffer.byteLength(truncated)).toBeLessThanOrEqual(100);
    expect(truncated).toEndWith(TRUNCATION_MARKER);
  });
});

describe("page fetching", () => {
  test("round-trips an opaque path and resolves a one-link stub", async () => {
    requestedPaths.length = 0;
    const result = await fetchResolvedPage(
      baseUrl,
      "/manual/a%2Fb/",
      1,
      40_000,
    );

    expect(requestedPaths).toEqual([
      "/manual/a%2Fb/",
      "/manual/a%2Fb/Target%2FPage/",
    ]);
    expect(result.markdown).toContain("## Stub page");
    expect(result.markdown).toContain("Stub page → resolved target:");
    expect(result.markdown).toContain("# Resolved");
  });

  test("returns image data and rejects invalid or oversized content", async () => {
    const image = await fetchImage(baseUrl, "/image%2Fsmall.png");
    expect(image.mimeType).toBe("image/png");
    expect(Buffer.from(image.data, "base64")).toEqual(
      validPng,
    );

    await expect(fetchImage(baseUrl, "/not-an-image")).rejects.toThrow(
      "not an image",
    );
    await expect(fetchImage(baseUrl, "/image%2Flarge.png")).rejects.toThrow(
      `${MAX_IMAGE_BYTES + 1} bytes`,
    );
    await expect(fetchImage(baseUrl, "/image%2Fbroken.png")).rejects.toThrow(
      "payload is invalid",
    );
  });
});
