import { afterAll, describe, expect, test } from "bun:test";
import {
  convertHtmlToMarkdown,
  extractTreeLinks,
  fetchImage,
  fetchResolvedPage,
  MAX_IMAGE_BYTES,
  normalizeSitePath,
  parseImageDimensions,
  truncateMarkdown,
  TRUNCATION_MARKER,
} from "../src/page.js";

const requestedPaths: string[] = [];
const validPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
// Minimal 1x1 JPEG (SOF0 with width=1, height=1).
const validJpeg = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
  0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43,
  0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08, 0x07, 0x07, 0x07, 0x09,
  0x09, 0x08, 0x0a, 0x0c, 0x14, 0x0d, 0x0c, 0x0b, 0x0b, 0x0c, 0x19, 0x12,
  0x13, 0x0f, 0x14, 0x1d, 0x1a, 0x1f, 0x1e, 0x1d, 0x1a, 0x1c, 0x1c, 0x20,
  0x24, 0x2e, 0x27, 0x20, 0x22, 0x2c, 0x23, 0x1c, 0x1c, 0x28, 0x37, 0x29,
  0x2c, 0x30, 0x31, 0x34, 0x34, 0x34, 0x1f, 0x27, 0x39, 0x3d, 0x38, 0x32,
  0x3c, 0x2e, 0x33, 0x34, 0x32, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01,
  0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9,
]);
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
      headers: {
        "content-type": "image/png",
        "content-length": String(validPng.byteLength),
      },
    });
  }
  if (url.pathname === "/image%2Fsmall.jpg") {
    return new Response(validJpeg, {
      headers: {
        "content-type": "image/jpeg",
        "content-length": String(validJpeg.byteLength),
      },
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
  if (url.pathname === "/image%2Ftruncated-ihdr.png") {
    // Valid PNG signature, truncated before width/height fields.
    return new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]), {
      headers: { "content-type": "image/png" },
    });
  }
  if (url.pathname === "/image%2Fzero.png") {
    const zero = Buffer.from(validPng);
    zero.writeUInt32BE(0, 16);
    zero.writeUInt32BE(0, 20);
    return new Response(zero, {
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

const treeFixtureHtml = String.raw`
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
const treeFixtureUrl = "http://backend/Vehicle/Repair%20and%20Diagnosis/";

describe("page conversion", () => {
  test("normalizes links, preserves encoded slashes, annotates scope, and prunes trees", () => {
    const result = convertHtmlToMarkdown(treeFixtureHtml, treeFixtureUrl, 1);

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

  test("extractTreeLinks matches convertHtmlToMarkdown links", async () => {
    const converted = convertHtmlToMarkdown(treeFixtureHtml, treeFixtureUrl, 1);
    const extracted = await extractTreeLinks(treeFixtureHtml, treeFixtureUrl);
    expect(extracted).toEqual(converted.links);
  });

  test("extractTreeLinks skips SVG-namespace anchors", async () => {
    const html =
      '<ul><li><a href="/section">Section</a>' +
      '<svg><a href="/icon"><text>Icon</text></a></svg></li></ul>';
    const extracted = await extractTreeLinks(html, treeFixtureUrl);
    expect(extracted.map((link) => link.path)).toEqual(["/section"]);
    const converted = convertHtmlToMarkdown(html, treeFixtureUrl, 1);
    expect(converted.links.map((link) => link.path)).toEqual(["/section"]);
  });

  test("extractTreeLinks keeps word boundaries turndown collapses", async () => {
    // Turndown strips whitespace-only text nodes adjacent to a block child before
    // its link rule reads textContent, gluing the words together. The DOM walk
    // reads the uncollapsed tree and keeps the boundary. Accepted divergence: the
    // walk's title is the correct one and the index is rebuilt from scratch.
    const html =
      '<ul><li><a href="/Brake/">Brake <div>System</div> Repair</a></li></ul>';
    const extracted = await extractTreeLinks(html, treeFixtureUrl);
    const converted = convertHtmlToMarkdown(html, treeFixtureUrl, 1);
    expect(extracted[0]?.path).toBe(converted.links[0]?.path);
    expect(extracted[0]?.title).toBe("Brake System Repair");
    expect(converted.links[0]?.title).toBe("BrakeSystemRepair");
  });

  test("extractTreeLinks matches turndown for adjacent block children", async () => {
    // Neither path inserts a separator between sibling blocks, so titles agree.
    const html =
      '<ul><li><a href="/Brake/"><div>Brake</div><div>System Repair</div></a></li></ul>';
    const extracted = await extractTreeLinks(html, treeFixtureUrl);
    const converted = convertHtmlToMarkdown(html, treeFixtureUrl, 1);
    expect(extracted[0]?.title).toBe("BrakeSystem Repair");
    expect(converted.links[0]?.title).toBe(extracted[0]?.title);
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

describe("image dimensions", () => {
  test("parses PNG and JPEG intrinsic size", () => {
    expect(parseImageDimensions(validPng, "image/png")).toEqual({
      width: 1,
      height: 1,
    });
    expect(parseImageDimensions(validJpeg, "image/jpeg")).toEqual({
      width: 1,
      height: 1,
    });
    expect(parseImageDimensions(validPng, "image/webp")).toBeUndefined();
  });

  test("parses JPEG dimensions when fill bytes precede a marker", () => {
    // SOI, APP0, 0xFF fill, SOF0 (300x400), EOI — legal per JPEG fill-byte rules.
    const withFill = new Uint8Array([
      0xff, 0xd8, // SOI
      0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, // APP0, length 4
      0xff, 0xff, // fill byte before next marker
      0xc0, 0x00, 0x0b, 0x08, 0x01, 0x2c, 0x01, 0x90, 0x01, 0x01, 0x11, 0x00, // SOF0
      0xff, 0xd9, // EOI
    ]);
    expect(parseImageDimensions(withFill, "image/jpeg")).toEqual({
      width: 400,
      height: 300,
    });
  });

  test("rejects PNG payloads whose first chunk is not IHDR", () => {
    const notIhdr = new Uint8Array([
      137, 80, 78, 71, 13, 10, 26, 10, // signature
      0, 0, 0, 13, // length
      0x49, 0x45, 0x4e, 0x44, // "IEND" instead of IHDR
      0, 0, 1, 0, // would look like width=256 if trusted
      0, 0, 1, 0, // height=256
    ]);
    expect(parseImageDimensions(notIhdr, "image/png")).toBeNull();
  });

  test("rejects truncated or zero-dimension PNG/JPEG payloads", () => {
    const truncated = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
    expect(parseImageDimensions(truncated, "image/png")).toBeNull();
    const zero = Buffer.from(validPng);
    zero.writeUInt32BE(0, 16);
    zero.writeUInt32BE(0, 20);
    expect(parseImageDimensions(zero, "image/png")).toEqual({ width: 0, height: 0 });
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

    const jpeg = await fetchImage(baseUrl, "/image%2Fsmall.jpg");
    expect(jpeg.mimeType).toBe("image/jpeg");

    await expect(fetchImage(baseUrl, "/not-an-image")).rejects.toThrow(
      "not an image",
    );
    await expect(fetchImage(baseUrl, "/image%2Flarge.png")).rejects.toThrow(
      `${MAX_IMAGE_BYTES + 1} bytes`,
    );
    await expect(fetchImage(baseUrl, "/image%2Fbroken.png")).rejects.toThrow(
      "payload is invalid",
    );
    await expect(fetchImage(baseUrl, "/image%2Ftruncated-ihdr.png")).rejects.toThrow(
      "payload is invalid",
    );
    await expect(fetchImage(baseUrl, "/image%2Fzero.png")).rejects.toThrow(
      "payload is invalid",
    );
  });
});
