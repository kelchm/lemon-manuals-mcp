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

export interface VehicleSearchResult extends Vehicle {
  variants: string[];
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
  vehicle: VehicleSearchResult;
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

    this.entries = [...byManual.values()];
    this.makes = [...byMake.values()].sort((a, b) =>
      a.make.localeCompare(b.make),
    );
  }

  get size(): number {
    return this.vehicleCount;
  }

  /** Every whitespace-separated query token must appear in the manual haystack. */
  search(query: string, limit: number): VehicleSearchResult[] {
    const tokens = normalize(query).split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return [];
    const results: VehicleSearchResult[] = [];
    for (const { vehicle, haystack } of this.entries) {
      if (tokens.every((t) => haystack.includes(t))) {
        results.push(vehicle);
        if (results.length >= limit) break;
      }
    }
    return results;
  }
}
