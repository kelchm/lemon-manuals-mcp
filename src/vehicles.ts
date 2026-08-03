import { readFileSync } from "node:fs";

export interface Vehicle {
  make: string;
  years: string[];
  model: string;
  engine: string | null;
  uriPath: string;
  isComplete: boolean;
  database: "lemon" | "charm";
}

/** Slim manual handle returned by search_vehicles (not the internal index entry). */
export interface ManualRef {
  database: "lemon" | "charm";
  engine: string | null;
  uriPath: string;
}

export interface VehicleSearchResult extends Vehicle {
  variants: string[];
  databases: ("lemon" | "charm")[];
  manuals: ManualRef[];
}

interface IndexedVehicle extends Vehicle {
  variants: string[];
  databases: ("lemon" | "charm")[];
  manuals: Vehicle[];
}

interface IndexFile {
  database: string;
  vehicles: {
    make: string;
    years: string[];
    model: string;
    engine: string | null;
    uriPath: string;
    rootUriTable?: string;
    rootLinkTable?: string;
    isComplete: boolean;
  }[];
}

export interface MakeSummary {
  make: string;
  vehicleCount: number;
  minYear: number;
  maxYear: number;
  databases: string[];
}

export const normalize = (s: string): string =>
  s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9 ]+/g, " ");

interface SearchEntry {
  vehicle: IndexedVehicle;
  haystack: string;
}

export class VehicleIndex {
  private entries: SearchEntry[] = [];
  private vehicleCount = 0;
  readonly makes: MakeSummary[];

  constructor(indexFiles: { lemon: string; charm: string }) {
    const byManual = new Map<string, SearchEntry>();
    const byMake = new Map<string, MakeSummary>();

    for (const database of ["lemon", "charm"] as const) {
      const parsed = JSON.parse(
        readFileSync(indexFiles[database], "utf8"),
      ) as IndexFile;
      for (const v of parsed.vehicles) {
        this.vehicleCount += 1;
        const vehicle: Vehicle = {
          make: v.make,
          years: v.years,
          model: v.model,
          engine: v.engine,
          uriPath: v.uriPath,
          isComplete: v.isComplete,
          database,
        };
        const manualKey = v.rootUriTable
          ? `root:${v.rootUriTable}`
          : `path:${database}:${v.uriPath}`;
        const variant = v.engine?.trim() ?? "";
        const vehicleHaystack = normalize(
          `${v.make} ${v.model} ${v.engine ?? ""} ${v.years.join(" ")}`,
        );
        const existing = byManual.get(manualKey);
        if (existing) {
          if (variant && !existing.vehicle.variants.includes(variant)) {
            existing.vehicle.variants.push(variant);
          }
          existing.haystack += ` ${vehicleHaystack}`;
        } else {
          byManual.set(manualKey, {
            vehicle: {
              ...vehicle,
              variants: variant ? [variant] : [],
              databases: [database],
              manuals: [],
            },
            haystack: vehicleHaystack,
          });
        }

        const summary = byMake.get(v.make) ?? {
          make: v.make,
          vehicleCount: 0,
          minYear: 9999,
          maxYear: 0,
          databases: [],
        };
        summary.vehicleCount += 1;
        for (const y of v.years) {
          const year = Number(y);
          if (!Number.isNaN(year)) {
            summary.minYear = Math.min(summary.minYear, year);
            summary.maxYear = Math.max(summary.maxYear, year);
          }
        }
        if (!summary.databases.includes(database)) {
          summary.databases.push(database);
        }
        byMake.set(v.make, summary);
      }
    }

    const byDrivetrain = new Map<string, SearchEntry>();
    for (const entry of byManual.values()) {
      const { vehicle } = entry;
      const modelFamily = normalize(vehicle.model.replace(/\([^)]*\)/g, " "))
        .trim()
        .replace(/\s+/g, " ");
      const displacement = vehicle.engine?.match(/\b(\d+\.\d+)\s*l?\b/i)?.[1];
      // Displacement is the only shared engine vocabulary between the terse
      // LEMON labels ("4.2 M") and CHARM labels ("V8-4.2L (BHX)"). Keep
      // unparseable engines separate rather than guessing.
      const drivetrainKey = displacement
        ? [
            normalize(vehicle.make),
            [...vehicle.years].sort().join(","),
            modelFamily,
            displacement,
          ].join("|")
        : `manual:${vehicle.database}:${vehicle.uriPath}`;
      const existing = byDrivetrain.get(drivetrainKey);
      const manual: Vehicle = {
        make: vehicle.make,
        years: vehicle.years,
        model: vehicle.model,
        engine: vehicle.engine,
        uriPath: vehicle.uriPath,
        isComplete: vehicle.isComplete,
        database: vehicle.database,
      };
      if (!existing) {
        byDrivetrain.set(drivetrainKey, {
          vehicle: {
            ...vehicle,
            databases: [vehicle.database],
            manuals: [manual],
          },
          haystack: entry.haystack,
        });
        continue;
      }
      existing.haystack += ` ${entry.haystack}`;
      existing.vehicle.manuals.push(manual);
      if (!existing.vehicle.databases.includes(vehicle.database)) {
        existing.vehicle.databases.push(vehicle.database);
      }
      for (const variant of vehicle.variants) {
        if (!existing.vehicle.variants.includes(variant)) {
          existing.vehicle.variants.push(variant);
        }
      }
      // Prefer CHARM's descriptive engine code and cleaner tree as the primary
      // backward-compatible uriPath, while retaining every manual above.
      if (
        vehicle.database === "charm" &&
        existing.vehicle.database !== "charm"
      ) {
        Object.assign(existing.vehicle, manual, {
          variants: existing.vehicle.variants,
          databases: existing.vehicle.databases,
          manuals: existing.vehicle.manuals,
        });
      }
    }

    this.entries = [...byDrivetrain.values()];
    this.makes = [...byMake.values()].sort((a, b) =>
      a.make.localeCompare(b.make),
    );
  }

  get size(): number {
    return this.vehicleCount;
  }

  completeVehicleRoots(): string[] {
    const roots = new Set<string>();
    for (const { vehicle } of this.entries) {
      for (const manual of vehicle.manuals) {
        if (manual.isComplete) roots.add(manual.uriPath);
      }
    }
    return [...roots];
  }

  /** Every whitespace-separated query token must appear in the manual haystack. */
  search(query: string, limit: number): VehicleSearchResult[] {
    const tokens = normalize(query).split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return [];
    const results: VehicleSearchResult[] = [];
    for (const { vehicle, haystack } of this.entries) {
      if (tokens.every((t) => haystack.includes(t))) {
        // Trim manuals for the wire payload only; completeVehicleRoots needs full entries.
        results.push({
          ...vehicle,
          manuals: vehicle.manuals.map(({ database, engine, uriPath }) => ({
            database,
            engine,
            uriPath,
          })),
        });
        if (results.length >= limit) break;
      }
    }
    return results;
  }
}
