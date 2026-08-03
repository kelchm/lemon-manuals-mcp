import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { PublicError, errorDetail } from "./errors.js";
import { fetchDocumentPage, fetchPage, type PageLink } from "./page.js";
import { normalize } from "./vehicles.js";

const REPAIR_TREE_SEGMENT = "Repair%20and%20Diagnosis/";
const BODY_FETCH_CONCURRENCY = 8;

export type ManualSearchMode = "title" | "body" | "both";

export interface ApplicabilityRange {
  from?: string;
  through?: string;
  appliesToVehicleYear: boolean | null;
}

export interface ManualSearchResult {
  title: string;
  path: string;
  breadcrumb: string[];
  also_under: string[][];
  snippet: string;
  image_only: boolean;
  applicability?: ApplicabilityRange;
}

interface DocumentRow {
  id: number;
  vehicle_root: string;
  title: string;
  path: string;
  breadcrumb: string;
  body_text: string;
  image_only: number;
  body_indexed: number;
  child_count: number;
  content_hash: string | null;
  applicable_from: string | null;
  applicable_through: string | null;
  rank?: number;
}

interface IndexState {
  titles_indexed: number;
  bodies_indexed: number;
}

function appendSegment(root: string, segment: string): string {
  return `${root}${root.endsWith("/") ? "" : "/"}${segment}`;
}

export function repairTreePath(vehicleRootPath: string): string {
  return appendSegment(vehicleRootPath, REPAIR_TREE_SEGMENT);
}

function ftsTerms(query: string): string {
  return normalize(query)
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => `"${token.replace(/"/g, '""')}"*`)
    .join(" AND ");
}

function ftsQuery(query: string, mode: ManualSearchMode): string {
  const terms = ftsTerms(query);
  if (mode === "title") return `title : (${terms})`;
  if (mode === "body") return `body_text : (${terms})`;
  return terms;
}

function markdownBody(markdown: string, title: string): string {
  let text = markdown
    .replace(/!\[[^\]]*\]\(<[^>]+>(?:\s+"[^"]*")?\)/g, " ")
    .replace(/\[([^\]]+)\]\(<[^>]+>(?:\s+"[^"]*")?\)/g, "$1")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/^[#>*+\-\d.()\s]+/gm, " ")
    .replace(/[`_*~|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const normalizedTitle = title.replace(/\s+/g, " ").trim();
  if (normalizedTitle && text.toLowerCase().startsWith(normalizedTitle.toLowerCase())) {
    text = text.slice(normalizedTitle.length).replace(/^\s*[-:–—]?\s*/, "");
  }
  return text;
}

function snippet(body: string, imageOnly: boolean): string {
  if (!body) {
    return imageOnly
      ? "[Image-only page; no searchable text.]"
      : "[No page body text is available.]";
  }
  const points = [...body];
  return points.length <= 200 ? body : `${points.slice(0, 200).join("")}…`;
}

function contentHash(body: string, imagePaths: string[]): string {
  return createHash("sha256")
    .update(body)
    .update("\0")
    .update([...imagePaths].sort().join("\n"))
    .digest("hex");
}

interface ParsedScope {
  from: string | null;
  through: string | null;
}

function expandYear(year: string): number {
  const value = Number(year);
  if (year.length === 4) return value;
  return value >= 60 ? 1900 + value : 2000 + value;
}

/** Parse publisher labels such as "Through 11.06" and "From MY 2007". */
export function parseApplicability(value: string): ParsedScope {
  const scope: ParsedScope = { from: null, through: null };
  const pattern = /\b(from|through)\s+(?:(\d{2})\.(\d{2})|MY\s+(\d{4}))\b/gi;
  for (const match of value.matchAll(pattern)) {
    const boundary = match[1]?.toLowerCase() as "from" | "through";
    const modelYear = match[4];
    const parsed = modelYear
      ? modelYear
      : `${expandYear(match[3] ?? "0")}-${match[2]}`;
    if (boundary === "from") scope.from = parsed;
    else scope.through = parsed;
  }
  return scope;
}

function vehicleYear(path: string): number | undefined {
  const match = path.match(/^\/[^/]+\/(\d{4})(?:\/|$)/);
  return match?.[1] ? Number(match[1]) : undefined;
}

function appliesToYear(
  year: number | undefined,
  from: string | null,
  through: string | null,
): boolean | null {
  if (year === undefined || (!from && !through)) return null;
  const startYear = from ? Number(from.slice(0, 4)) : undefined;
  const endYear = through ? Number(through.slice(0, 4)) : undefined;
  if (startYear !== undefined && year < startYear) return false;
  if (endYear !== undefined && year > endYear) return false;
  // A model year does not identify a build month, so a same-year month boundary
  // cannot be classified safely.
  if ((from?.includes("-") && startYear === year) ||
      (through?.includes("-") && endYear === year)) return null;
  return true;
}

async function mapConcurrent<T>(
  values: T[],
  concurrency: number,
  work: (value: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      for (;;) {
        const index = next++;
        const value = values[index];
        if (value === undefined) return;
        await work(value);
      }
    }),
  );
}

export class ManualSearchIndex {
  readonly db: Database;

  constructor(path = ":memory:") {
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS manual_index_state (
        vehicle_root TEXT PRIMARY KEY,
        titles_indexed INTEGER NOT NULL DEFAULT 0,
        bodies_indexed INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS manual_documents (
        id INTEGER PRIMARY KEY,
        vehicle_root TEXT NOT NULL,
        title TEXT NOT NULL,
        path TEXT NOT NULL,
        breadcrumb TEXT NOT NULL,
        body_text TEXT NOT NULL DEFAULT '',
        image_only INTEGER NOT NULL DEFAULT 0,
        body_indexed INTEGER NOT NULL DEFAULT 0,
        child_count INTEGER NOT NULL DEFAULT 0,
        content_hash TEXT,
        applicable_from TEXT,
        applicable_through TEXT,
        fetch_error TEXT,
        UNIQUE(vehicle_root, path)
      );
      CREATE INDEX IF NOT EXISTS manual_documents_root_hash
        ON manual_documents(vehicle_root, content_hash);
      CREATE VIRTUAL TABLE IF NOT EXISTS manual_documents_fts USING fts5(
        title, breadcrumb, body_text,
        content='manual_documents', content_rowid='id',
        tokenize='unicode61 remove_diacritics 2'
      );
      CREATE TRIGGER IF NOT EXISTS manual_documents_ai AFTER INSERT ON manual_documents BEGIN
        INSERT INTO manual_documents_fts(rowid, title, breadcrumb, body_text)
        VALUES (new.id, new.title, new.breadcrumb, new.body_text);
      END;
      CREATE TRIGGER IF NOT EXISTS manual_documents_ad AFTER DELETE ON manual_documents BEGIN
        INSERT INTO manual_documents_fts(manual_documents_fts, rowid, title, breadcrumb, body_text)
        VALUES ('delete', old.id, old.title, old.breadcrumb, old.body_text);
      END;
      CREATE TRIGGER IF NOT EXISTS manual_documents_au AFTER UPDATE ON manual_documents BEGIN
        INSERT INTO manual_documents_fts(manual_documents_fts, rowid, title, breadcrumb, body_text)
        VALUES ('delete', old.id, old.title, old.breadcrumb, old.body_text);
        INSERT INTO manual_documents_fts(rowid, title, breadcrumb, body_text)
        VALUES (new.id, new.title, new.breadcrumb, new.body_text);
      END;
    `);
  }

  close(): void {
    this.db.close();
  }

  private state(vehicleRoot: string): IndexState | null {
    return this.db
      .query(
        "SELECT titles_indexed, bodies_indexed FROM manual_index_state WHERE vehicle_root = ?",
      )
      .get(vehicleRoot) as IndexState | null;
  }

  private async ensureTitles(baseUrl: string, vehicleRoot: string): Promise<void> {
    if (this.state(vehicleRoot)?.titles_indexed) return;

    let links: PageLink[];
    try {
      const tree = await fetchPage(
        baseUrl,
        repairTreePath(vehicleRoot),
        Number.MAX_SAFE_INTEGER,
      );
      links = tree.links.filter(
        (link) => link.title && link.breadcrumb.length > 0,
      );
    } catch (cause) {
      throw new PublicError(
        "Title search is unavailable for this manual.",
        `Could not index ${repairTreePath(vehicleRoot)}: ${errorDetail(cause)}`,
        { cause },
      );
    }
    if (links.length === 0) {
      throw new PublicError(
        "Title search is unavailable for this manual.",
        `Repair tree ${repairTreePath(vehicleRoot)} returned no indexable links`,
      );
    }

    const insert = this.db.prepare(`
      INSERT INTO manual_documents (
        vehicle_root, title, path, breadcrumb, child_count,
        applicable_from, applicable_through
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(vehicle_root, path) DO UPDATE SET
        title=excluded.title, breadcrumb=excluded.breadcrumb,
        child_count=excluded.child_count,
        applicable_from=excluded.applicable_from,
        applicable_through=excluded.applicable_through
    `);
    const save = this.db.transaction((items: PageLink[]) => {
      for (const link of items) {
        const scope = parseApplicability(link.breadcrumb.join(" "));
        insert.run(
          vehicleRoot,
          link.title,
          link.path,
          JSON.stringify(link.breadcrumb),
          link.childCount,
          scope.from,
          scope.through,
        );
      }
      this.db.prepare(`
        INSERT INTO manual_index_state(vehicle_root, titles_indexed, bodies_indexed, updated_at)
        VALUES (?, 1, 0, ?)
        ON CONFLICT(vehicle_root) DO UPDATE SET titles_indexed=1, updated_at=excluded.updated_at
      `).run(vehicleRoot, new Date().toISOString());
    });
    save(links);
  }

  private async hydrateRows(baseUrl: string, rows: DocumentRow[]): Promise<void> {
    const update = this.db.prepare(`
      UPDATE manual_documents SET body_text=?, image_only=?, body_indexed=1,
        content_hash=?, fetch_error=? WHERE id=?
    `);
    await mapConcurrent(rows, BODY_FETCH_CONCURRENCY, async (row) => {
      if (row.child_count > 0) {
        update.run("", 0, null, null, row.id);
        return;
      }
      try {
        const page = await fetchDocumentPage(baseUrl, row.path, 1);
        const body = markdownBody(page.markdown, row.title);
        const imageOnly = body.length === 0 && page.imagePaths.length > 0;
        update.run(
          body,
          imageOnly ? 1 : 0,
          contentHash(body || page.markdown, page.imagePaths),
          null,
          row.id,
        );
      } catch (error) {
        console.error(
          `[lemon-mcp] body indexing failed for ${row.path}: ${errorDetail(error)}`,
        );
        update.run(
          "",
          0,
          createHash("sha256").update(`unavailable\0${row.path}`).digest("hex"),
          errorDetail(error),
          row.id,
        );
      }
    });
  }

  private async ensureBodies(baseUrl: string, vehicleRoot: string): Promise<void> {
    if (this.state(vehicleRoot)?.bodies_indexed) return;
    const rows = this.db
      .query(
        "SELECT * FROM manual_documents WHERE vehicle_root=? AND body_indexed=0",
      )
      .all(vehicleRoot) as DocumentRow[];
    await this.hydrateRows(baseUrl, rows);
    this.db.prepare(
      "UPDATE manual_index_state SET bodies_indexed=1, updated_at=? WHERE vehicle_root=?",
    ).run(new Date().toISOString(), vehicleRoot);
  }

  /** Fully ingest one manual. Used by the offline index builder and body search. */
  async indexManual(baseUrl: string, vehicleRoot: string): Promise<void> {
    await this.ensureTitles(baseUrl, vehicleRoot);
    await this.ensureBodies(baseUrl, vehicleRoot);
  }

  private matchingRows(
    vehicleRoot: string,
    query: string,
    mode: ManualSearchMode,
  ): DocumentRow[] {
    return this.db.query(`
      SELECT d.*, bm25(manual_documents_fts, 8.0, 1.0, 2.0) AS rank
      FROM manual_documents_fts
      JOIN manual_documents d ON d.id = manual_documents_fts.rowid
      WHERE d.vehicle_root = ? AND manual_documents_fts MATCH ?
      ORDER BY rank, d.id
    `).all(vehicleRoot, ftsQuery(query, mode)) as DocumentRow[];
  }

  async search(
    baseUrl: string,
    vehicleRoot: string,
    query: string,
    limit: number,
    mode: ManualSearchMode = "both",
  ): Promise<ManualSearchResult[]> {
    if (!ftsTerms(query)) return [];
    await this.ensureTitles(baseUrl, vehicleRoot);
    if (mode === "title") {
      const candidates = this.matchingRows(vehicleRoot, query, mode).filter(
        (row) => !row.body_indexed,
      );
      await this.hydrateRows(baseUrl, candidates);
    } else {
      await this.ensureBodies(baseUrl, vehicleRoot);
    }

    const matches = this.matchingRows(vehicleRoot, query, mode);
    const unique = new Map<string, DocumentRow>();
    for (const row of matches) {
      const key = row.content_hash ?? `path:${row.path}`;
      const existing = unique.get(key);
      if (
        !existing ||
        ((!existing.applicable_from && !existing.applicable_through) &&
          (Boolean(row.applicable_from) || Boolean(row.applicable_through)))
      ) {
        unique.set(key, row);
      }
    }

    const year = vehicleYear(vehicleRoot);
    const results: ManualSearchResult[] = [];
    for (const row of unique.values()) {
      const breadcrumb = JSON.parse(row.breadcrumb) as string[];
      const aliases = row.content_hash
        ? (this.db.query(`
            SELECT breadcrumb FROM manual_documents
            WHERE vehicle_root=? AND content_hash=? AND id<>?
            ORDER BY id
          `).all(vehicleRoot, row.content_hash, row.id) as { breadcrumb: string }[])
        : [];
      const result: ManualSearchResult = {
        title: row.title,
        path: row.path,
        breadcrumb,
        also_under: aliases.map((alias) => JSON.parse(alias.breadcrumb) as string[]),
        snippet: snippet(row.body_text, Boolean(row.image_only)),
        image_only: Boolean(row.image_only),
      };
      if (row.applicable_from || row.applicable_through) {
        result.applicability = {
          ...(row.applicable_from ? { from: row.applicable_from } : {}),
          ...(row.applicable_through ? { through: row.applicable_through } : {}),
          appliesToVehicleYear: appliesToYear(
            year,
            row.applicable_from,
            row.applicable_through,
          ),
        };
      }
      results.push(result);
      if (results.length >= limit) break;
    }
    return results;
  }
}

let defaultIndex = new ManualSearchIndex();

export async function searchManual(
  baseUrl: string,
  vehicleRootPath: string,
  query: string,
  limit: number,
  mode: ManualSearchMode = "both",
): Promise<ManualSearchResult[]> {
  return defaultIndex.search(baseUrl, vehicleRootPath, query, limit, mode);
}

export function clearManualSearchCache(): void {
  defaultIndex.close();
  defaultIndex = new ManualSearchIndex();
}
