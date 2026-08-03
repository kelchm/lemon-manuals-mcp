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

  test("groups equivalent LEMON and CHARM drivetrains and exposes every source", () => {
    const lemonPath = join(fixtureDir, "lemon-touareg.json");
    const charmPath = join(fixtureDir, "charm-touareg.json");
    const base = {
      make: "Volkswagen",
      years: ["2005"],
      model: "Touareg",
      isComplete: true,
    };
    writeFileSync(lemonPath, JSON.stringify({ database: "lemon", vehicles: [
      { ...base, engine: "3.2 C", uriPath: "/Volkswagen/2005/Touareg%203.2%20C/" },
      { ...base, engine: "3.2 G", uriPath: "/Volkswagen/2005/Touareg%203.2%20G/" },
      { ...base, engine: "4.2 M", uriPath: "/Volkswagen/2005/Touareg%204.2%20M/" },
    ] }));
    writeFileSync(charmPath, JSON.stringify({ database: "charm", vehicles: [
      { ...base, model: "Touareg (7LA)", engine: "V6-3.2L (BMX)", uriPath: "/Volkswagen/2005/Touareg%20V6-3.2L/" },
      { ...base, model: "Touareg (7LA)", engine: "V8-4.2L (BHX)", uriPath: "/Volkswagen/2005/Touareg%20V8-4.2L/" },
      { ...base, model: "Touareg (7LA)", engine: "V10-5.0L DSL Turbo (BKW)", uriPath: "/Volkswagen/2005/Touareg%20V10-5.0L/" },
    ] }));

    const index = new VehicleIndex({ lemon: lemonPath, charm: charmPath });
    const results = index.search("2005 touareg", 20);

    expect(results).toHaveLength(3);
    expect(results[0]?.database).toBe("charm");
    expect(results[0]?.databases).toEqual(["lemon", "charm"]);
    expect(results[0]?.variants).toEqual(["3.2 C", "3.2 G", "V6-3.2L (BMX)"]);
    expect(results[0]?.manuals).toHaveLength(3);
  });
});
