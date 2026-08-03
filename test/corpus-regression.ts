// Optional live corpus regression. Run with a port-forward and:
//   bun run live-corpus
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManualSearchIndex, repairTreePath } from "../src/manual.js";
import { fetchPage } from "../src/page.js";
import { VehicleIndex, normalize } from "../src/vehicles.js";

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
    const leaf = tree.links.find((link) =>
      link.childCount === 0 && normalize(link.title).split(/\s+/).some((word) => word.length >= 4));
    assert(leaf, `${label} has no searchable leaf`);
    const query = normalize(leaf.title).split(/\s+/).find((word) => word.length >= 4);
    assert(query);
    const results = await searchIndex.search(baseUrl, root, query, 100, "title");
    assert(results.length > 0, `${label} title search returned no results for ${query}`);
    console.log(`${label}: ${results.length} result(s) for ${query}`);
  }
} finally {
  searchIndex.close();
  rmSync(temporary, { recursive: true });
}
