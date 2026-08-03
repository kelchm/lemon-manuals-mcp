import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VehicleIndex } from "../src/vehicles.js";

const fixtureDir = mkdtempSync(join(tmpdir(), "lemon-vehicles-test-"));

afterAll(() => rmSync(fixtureDir, { recursive: true }));

describe("VehicleIndex.search", () => {
  test("deduplicates manuals before applying the limit and hides table keys", () => {
    const shared = {
      make: "Example",
      years: ["2020"],
      model: "Model",
      uriPath: "/Example/2020/Model%20Base/",
      rootUriTable: "shared-root",
      rootLinkTable: "internal-link-table",
      isComplete: true,
    };
    const lemonPath = join(fixtureDir, "lemon.json");
    const charmPath = join(fixtureDir, "charm.json");
    writeFileSync(
      lemonPath,
      JSON.stringify({
        database: "lemon",
        vehicles: [
          { ...shared, engine: "Base" },
          { ...shared, engine: "Sport" },
          {
            ...shared,
            engine: "Touring",
            uriPath: "/Example/2020/Model%20Touring/",
            rootUriTable: "second-root",
          },
        ],
      }),
    );
    writeFileSync(charmPath, JSON.stringify({ database: "charm", vehicles: [] }));

    const index = new VehicleIndex({ lemon: lemonPath, charm: charmPath });
    const results = index.search("example 2020", 2);

    expect(results).toHaveLength(2);
    expect(results[0]?.variants).toEqual(["Base", "Sport"]);
    expect(results[0]).not.toHaveProperty("rootUriTable");
    expect(results[0]).not.toHaveProperty("rootLinkTable");
  });
});
