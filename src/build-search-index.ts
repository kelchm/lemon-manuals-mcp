import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { ManualSearchIndex } from "./manual.js";
import { VehicleIndex } from "./vehicles.js";

const baseUrl = process.env["LEMON_BASE_URL"] ?? "http://127.0.0.1:18080";
const dataDir = process.env["LEMON_DATA_DIR"] ?? join(import.meta.dir, "..", "data");
const searchDb = process.env["LEMON_SEARCH_DB"] ?? join(dataDir, "manual-search.sqlite");
const vehicles = new VehicleIndex({
  lemon: process.env["LEMON_INDEX_JSON"] ?? join(dataDir, "lemon-index.json"),
  charm: process.env["CHARM_INDEX_JSON"] ?? join(dataDir, "charm-index.json"),
});
const requestedRoots = process.argv.slice(2);
const roots = requestedRoots.length > 0
  ? requestedRoots
  : vehicles.completeVehicleRoots();

mkdirSync(dirname(searchDb), { recursive: true });
const searchIndex = new ManualSearchIndex(searchDb);
let completed = 0;
for (const root of roots) {
  try {
    await searchIndex.indexManual(baseUrl, root);
    completed += 1;
    console.error(`[lemon-index] ${completed}/${roots.length} indexed ${root}`);
  } catch (error) {
    console.error(`[lemon-index] failed ${root}:`, error);
  }
}
searchIndex.close();
if (completed !== roots.length) process.exitCode = 1;
