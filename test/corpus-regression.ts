// Optional live corpus regression. Run with a port-forward and:
//   bun run live-corpus
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManualSearchIndex, repairTreePath } from "../src/manual.js";
import { fetchImage, fetchPage, parseImageDimensions } from "../src/page.js";
import { VehicleIndex, normalize } from "../src/vehicles.js";

// J518 door-handle track diagram: the corpus is image-only for wiring diagrams,
// so this pins the whole image path against silent truncation or re-encoding.
const CANARY_IMAGE_PATH = "/images/IMP66Q313/euro600/891404313/";
const CANARY_IMAGE_BYTE_LENGTH = 22_388;
const CANARY_IMAGE_WIDTH = 1584;
const CANARY_IMAGE_HEIGHT = 2000;

const J518_ROOT =
  "/Volkswagen/2005/Touareg%20%287LA%29%20V8-4.2L%20%28BHX%29/";

const baseUrl = process.env["LEMON_BASE_URL"] ?? "http://127.0.0.1:18080";
const dataDir = process.env["LEMON_DATA_DIR"] ?? join(import.meta.dir, "..", "data");
const vehicles = new VehicleIndex({
  lemon: join(dataDir, "lemon-index.json"),
  charm: join(dataDir, "charm-index.json"),
});
const complete = new Set(vehicles.completeVehicleRoots());
const samples = [
  ["lemon-1960s", "/Alfa%20Romeo/1960/2000%20Berlina/"],
  ["lemon-1970s", "/Alfa%20Romeo/1970/Berlina%201.8L%20Eng%2C%20Automatic%20Trans/"],
  ["lemon-1980s", "/Alfa%20Romeo/1980/Spider/"],
  ["lemon-1990s", "/Acura/1990/Integra%20GS%2C%202D%20Hatchback%2C%20Automatic/"],
  ["lemon-2000s", "/Acura/2000/1.6EL%20RS%2C%20Automatic/"],
  ["lemon-2010s", "/Acura/2010/CSX%20Type-S/"],
  ["lemon-2020s", "/Acura/2020/ILX/"],
  ["charm-1980s", "/Buick/1982/Regal%20V8-267%204.4L/"],
  ["charm-1990s", "/Buick/1990/Skylark%20L4-151%202.5L/"],
  ["charm-2000s", "/Ford/2000/Escort%20L4-121%202.0L%20SOHC%20VIN%20P%20SFI/"],
  ["charm-2010s", "/Ford/2010/Fusion%20FWD%20L4-2.5L%20Hybrid/"],
] as const;

const temporary = mkdtempSync(join(tmpdir(), "lemon-live-regression-"));
const searchIndex = new ManualSearchIndex(join(temporary, "search.sqlite"));
try {
  for (const [label, root] of samples) {
    assert(complete.has(root), `${label} fixture is no longer isComplete`);
    const tree = await fetchPage(baseUrl, repairTreePath(root), Number.MAX_SAFE_INTEGER);
    // Match the indexer's filter. Without the breadcrumb check this picks LEMON's
    // "View \"full tree\"..." navigation link, which is deliberately not indexed.
    const leaf = tree.links.find((link) =>
      link.title && link.breadcrumb.length > 0 &&
      link.childCount === 0 && normalize(link.title).split(/\s+/).some((word) => word.length >= 4));
    assert(leaf, `${label} has no searchable leaf`);
    const query = normalize(leaf.title).split(/\s+/).find((word) => word.length >= 4);
    assert(query);
    const results = await searchIndex.search(baseUrl, root, query, 100, "title");
    assert(results.length > 0, `${label} title search returned no results for ${query}`);
    console.log(`${label}: ${results.length} result(s) for ${query}`);
  }

  // J518 applicability ordering on the known Touareg root.
  const j518 = await searchIndex.search(baseUrl, J518_ROOT, "J518", 50, "title");
  assert(j518.length > 0, "J518 title search returned no results");
  const firstFalse = j518.findIndex(
    (hit) => hit.applicability?.appliesToVehicleYear === false,
  );
  let lastTrueOrNull = -1;
  for (let i = j518.length - 1; i >= 0; i--) {
    if (j518[i]?.applicability?.appliesToVehicleYear !== false) {
      lastTrueOrNull = i;
      break;
    }
  }
  if (firstFalse !== -1 && lastTrueOrNull !== -1) {
    assert(
      firstFalse > lastTrueOrNull,
      "appliesToVehicleYear:true must rank above false for J518",
    );
  }
  console.log(`J518 ordering: ${j518.length} hit(s) on ${J518_ROOT}`);

  // Canary image dimensions (skipped until constants are pinned from a live run).
  if (CANARY_IMAGE_BYTE_LENGTH > 0) {
    const image = await fetchImage(baseUrl, CANARY_IMAGE_PATH);
    const bytes = Buffer.from(image.data, "base64");
    assert.equal(bytes.byteLength, CANARY_IMAGE_BYTE_LENGTH);
    const dims = parseImageDimensions(bytes, image.mimeType);
    assert(dims && dims.width === CANARY_IMAGE_WIDTH && dims.height === CANARY_IMAGE_HEIGHT);
    console.log(
      `canary image: ${bytes.byteLength} bytes ${dims.width}x${dims.height}`,
    );
  } else {
    console.log("canary image: skipped (TODO constants not pinned yet)");
  }

  // Nonexistent image returns a clean text error path via PublicError.
  await assert.rejects(
    () => fetchImage(baseUrl, "/images/does-not-exist/missing.png"),
    (error: unknown) =>
      error instanceof Error &&
      /unavailable|could not/i.test(error.message) &&
      !/svc\.cluster|127\.0\.0\.1:18080/.test(error.message),
  );
  console.log("missing image: clean PublicError");
} finally {
  searchIndex.close();
  rmSync(temporary, { recursive: true });
}
