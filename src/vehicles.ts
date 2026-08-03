import { readFileSync } from "node:fs";

export interface Vehicle {
  make: string;
  years: string[];
  model: string;
  engine: string;
  uriPath: string;
  isComplete: boolean;
  database: "lemon" | "charm";
}

interface IndexFile {
  database: string;
  vehicles: {
    make: string;
    years: string[];
    model: string;
    engine: string;
    uriPath: string;
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

const normalize = (s: string): string =>
  s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9 ]+/g, " ");

interface SearchEntry {
  vehicle: Vehicle;
  haystack: string;
}

export class VehicleIndex {
  private entries: SearchEntry[] = [];
  readonly makes: MakeSummary[];

  constructor(indexFiles: { lemon: string; charm: string }) {
    for (const database of ["lemon", "charm"] as const) {
      const parsed = JSON.parse(
        readFileSync(indexFiles[database], "utf8"),
      ) as IndexFile;
      for (const v of parsed.vehicles) {
        const vehicle: Vehicle = { ...v, database };
        this.entries.push({
          vehicle,
          haystack: normalize(
            `${v.make} ${v.model} ${v.engine} ${v.years.join(" ")}`,
          ),
        });
      }
    }

    const byMake = new Map<string, MakeSummary>();
    for (const { vehicle } of this.entries) {
      const summary = byMake.get(vehicle.make) ?? {
        make: vehicle.make,
        vehicleCount: 0,
        minYear: 9999,
        maxYear: 0,
        databases: [],
      };
      summary.vehicleCount += 1;
      for (const y of vehicle.years) {
        const year = Number(y);
        if (!Number.isNaN(year)) {
          summary.minYear = Math.min(summary.minYear, year);
          summary.maxYear = Math.max(summary.maxYear, year);
        }
      }
      if (!summary.databases.includes(vehicle.database)) {
        summary.databases.push(vehicle.database);
      }
      byMake.set(vehicle.make, summary);
    }
    this.makes = [...byMake.values()].sort((a, b) =>
      a.make.localeCompare(b.make),
    );
  }

  get size(): number {
    return this.entries.length;
  }

  /** Every whitespace-separated query token must appear in the entry haystack. */
  search(query: string, limit: number): Vehicle[] {
    const tokens = normalize(query).split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return [];
    const results: Vehicle[] = [];
    for (const { vehicle, haystack } of this.entries) {
      if (tokens.every((t) => haystack.includes(t))) {
        results.push(vehicle);
        if (results.length >= limit) break;
      }
    }
    return results;
  }
}
