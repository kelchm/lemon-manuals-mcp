import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { PublicError, errorDetail } from "./errors.js";
import { fetchDocumentPage, fetchTreeLinks, type PageLink } from "./page.js";
import { normalize } from "./vehicles.js";

const REPAIR_TREE_SEGMENT = "Repair%20and%20Diagnosis/";
const BODY_FETCH_CONCURRENCY = 8;
/** Bump when columns/FTS shape change; mismatched stores are dropped and rebuilt. */
const SCHEMA_VERSION = 2;
const SNIPPET_MAX_CHARS = 205;
/** bm25 is lower-is-better; subtract these to promote title/code matches in body mode. */
const TITLE_TOKEN_BOOST = 20;
const COMPONENT_CODE_BOOST = 10;
const COMPONENT_CODE_RE = /^[a-z]{1,2}\d{1,4}[a-z]?$/;

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
  snippet_text: string;
  image_count: number;
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

interface IndexedFields {
  bodyText: string;
  snippetText: string;
  imageOnly: boolean;
  imageCount: number;
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

/**
 * Rewrite publisher cross-reference markup to plain inner text. References come
 * both bracketed ("--> \[ Door Lock \]", whose target may wrap across lines) and
 * bare ("--> Owner's Manual"); Turndown also escapes the leading hyphen to "\-->".
 */
export function stripCrossReferences(text: string): string {
  return text
    .replace(/\\?-->\s*\\?\[\s*([\s\S]+?)\s*\\?\]/g, "$1")
    .replace(/\\?-->\s*/g, "")
    .replace(/\\([\[\]])/g, "$1");
}

function tokenSet(value: string): Set<string> {
  return new Set(normalize(value).split(/\s+/).filter(Boolean));
}

/** Jaccard similarity of two token sets: |intersection| / |union|. */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Drop ATX headings that are near-equal to the page title (Jaccard ≥ 0.8).
 * Avoids treating real section labels like "Removal" under "Removal and
 * Installation" as title chrome.
 */
export function suppressTitleHeadings(markdown: string, title: string): string {
  const titleTokens = tokenSet(title);
  if (titleTokens.size === 0) return markdown;
  return markdown.replace(/^(#{1,6})\s+(.+)$/gm, (line, _hashes: string, text: string) => {
    const headingTokens = tokenSet(text);
    if (headingTokens.size === 0) return line;
    return jaccardSimilarity(headingTokens, titleTokens) >= 0.8 ? "" : line;
  });
}

function flattenMarkdown(markdown: string): string {
  return stripCrossReferences(markdown)
    .replace(/!\[[^\]]*\]\(<[^>]+>(?:\s+"[^"]*")?\)/g, " ")
    .replace(/\[([^\]]+)\]\(<[^>]+>(?:\s+"[^"]*")?\)/g, "$1")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/^[#>*+\-\d.()\s]+/gm, " ")
    .replace(/[`_*~|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function imageOnlySnippet(imageCount: number): string {
  return imageCount === 1
    ? "[image only — 1 image]"
    : `[image only — ${imageCount} images]`;
}

function clipSnippet(body: string): string {
  const points = [...body];
  return points.length <= SNIPPET_MAX_CHARS
    ? body
    : `${points.slice(0, SNIPPET_MAX_CHARS).join("")}…`;
}

/** Split indexed body text from the display snippet (heading-suppressed prose). */
export function extractIndexedFields(
  markdown: string,
  title: string,
  imagePaths: string[],
): IndexedFields {
  const cleaned = stripCrossReferences(markdown);
  // Full searchable text keeps title-like headings so body-mode FTS still hits them.
  const bodyText = flattenMarkdown(cleaned);
  const prose = flattenMarkdown(suppressTitleHeadings(cleaned, title));
  const imageCount = imagePaths.length;
  const imageOnly = prose.length === 0 && imageCount > 0;
  let snippetText: string;
  if (imageOnly) {
    snippetText = imageOnlySnippet(imageCount);
  } else if (!prose) {
    snippetText = "[No page body text is available.]";
  } else {
    snippetText = clipSnippet(prose);
  }
  return { bodyText, snippetText, imageOnly, imageCount };
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

/** Promote body-mode hits whose title covers the query (bm25 title weight is unused). */
export function bodyModeScoreBoost(title: string, query: string): number {
  const queryTokens = normalize(query).split(/\s+/).filter(Boolean);
  if (queryTokens.length === 0) return 0;
  const titleTokens = tokenSet(title);
  let boost = 0;
  if (queryTokens.every((token) => titleTokens.has(token))) {
    boost += TITLE_TOKEN_BOOST;
  }
  for (const token of queryTokens) {
    if (COMPONENT_CODE_RE.test(token) && titleTokens.has(token)) {
      boost += COMPONENT_CODE_BOOST;
    }
  }
  return boost;
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

function yieldMacrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export class ManualSearchIndex {
  readonly db: Database;
  private readonly inflight = new Map<string, Promise<void>>();

  constructor(path = ":memory:") {
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.ensureSchema();
  }

  private ensureSchema(): void {
    const row = this.db.query("PRAGMA user_version").get() as
      | { user_version: number }
      | null;
    const version = row?.user_version ?? 0;
    const migrate = version !== SCHEMA_VERSION;
    // Drop + create + user_version must be atomic so a crash cannot leave a
    // content table without FTS triggers while user_version still reads current.
    // journal_mode stays outside (not transactional in SQLite).
    this.db.transaction(() => {
      if (migrate) {
        // Rebuildable cache: drop the whole store when the code expects a new shape.
        this.db.exec(`
          DROP TRIGGER IF EXISTS manual_documents_ai;
          DROP TRIGGER IF EXISTS manual_documents_ad;
          DROP TRIGGER IF EXISTS manual_documents_au;
          DROP TABLE IF EXISTS manual_documents_fts;
          DROP TABLE IF EXISTS manual_documents;
          DROP TABLE IF EXISTS manual_index_state;
        `);
      }
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
          snippet_text TEXT NOT NULL DEFAULT '',
          image_count INTEGER NOT NULL DEFAULT 0,
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
      if (migrate) {
        this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      }
    })();
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

  /** Share one in-flight job per key; clear on settle (success or rejection). */
  private runExclusive(key: string, work: () => Promise<void>): Promise<void> {
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const promise = work().finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, promise);
    return promise;
  }

  private async ensureTitles(baseUrl: string, vehicleRoot: string): Promise<void> {
    if (this.state(vehicleRoot)?.titles_indexed) return;
    await this.runExclusive(`titles:${vehicleRoot}`, async () => {
      if (this.state(vehicleRoot)?.titles_indexed) return;

      let links: PageLink[];
      try {
        links = (
          await fetchTreeLinks(baseUrl, repairTreePath(vehicleRoot))
        ).filter((link) => link.title && link.breadcrumb.length > 0);
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
    });
  }

  private async hydrateRows(baseUrl: string, rows: DocumentRow[]): Promise<void> {
    const update = this.db.prepare(`
      UPDATE manual_documents SET body_text=?, snippet_text=?, image_only=?,
        image_count=?, body_indexed=1, content_hash=?, fetch_error=? WHERE id=?
    `);
    await mapConcurrent(rows, BODY_FETCH_CONCURRENCY, async (row) => {
      if (row.child_count > 0) {
        update.run("", "", 0, 0, null, null, row.id);
        return;
      }
      try {
        const page = await fetchDocumentPage(baseUrl, row.path, 1);
        const fields = extractIndexedFields(page.markdown, row.title, page.imagePaths);
        // Yield after each conversion so a long ingest never monopolises the loop.
        await yieldMacrotask();
        update.run(
          fields.bodyText,
          fields.snippetText,
          fields.imageOnly ? 1 : 0,
          fields.imageCount,
          contentHash(fields.bodyText || page.markdown, page.imagePaths),
          null,
          row.id,
        );
      } catch (error) {
        console.error(
          `[lemon-mcp] body indexing failed for ${row.path}: ${errorDetail(error)}`,
        );
        update.run(
          "",
          "[No page body text is available.]",
          0,
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
    await this.runExclusive(`bodies:${vehicleRoot}`, async () => {
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
    });
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
    applicableOnly = false,
  ): Promise<ManualSearchResult[]> {
    if (!ftsTerms(query)) return [];
    await this.ensureTitles(baseUrl, vehicleRoot);
    if (mode === "title") {
      // Serialize title-mode hydration per vehicle so two concurrent searches
      // cannot both select body_indexed=0 and let a failure write clobber a
      // successful body write.
      await this.runExclusive(`title-hydrate:${vehicleRoot}`, async () => {
        const candidates = this.matchingRows(vehicleRoot, query, mode).filter(
          (row) => !row.body_indexed,
        );
        if (candidates.length > 0) {
          await this.hydrateRows(baseUrl, candidates);
        }
      });
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
    type Ranked = {
      result: ManualSearchResult;
      rank: number;
      id: number;
      nonApplicable: boolean;
    };
    const ranked: Ranked[] = [];
    for (const row of unique.values()) {
      const breadcrumb = JSON.parse(row.breadcrumb) as string[];
      const aliases = row.content_hash
        ? (this.db.query(`
            SELECT breadcrumb FROM manual_documents
            WHERE vehicle_root=? AND content_hash=? AND id<>?
            ORDER BY id
          `).all(vehicleRoot, row.content_hash, row.id) as { breadcrumb: string }[])
        : [];
      const applies =
        row.applicable_from || row.applicable_through
          ? appliesToYear(year, row.applicable_from, row.applicable_through)
          : null;
      if (applicableOnly && applies === false) continue;

      const result: ManualSearchResult = {
        title: row.title,
        path: row.path,
        breadcrumb,
        also_under: aliases.map((alias) => JSON.parse(alias.breadcrumb) as string[]),
        snippet: row.snippet_text || "[No page body text is available.]",
        image_only: Boolean(row.image_only),
      };
      if (row.applicable_from || row.applicable_through) {
        result.applicability = {
          ...(row.applicable_from ? { from: row.applicable_from } : {}),
          ...(row.applicable_through ? { through: row.applicable_through } : {}),
          appliesToVehicleYear: applies,
        };
      }

      const baseRank = row.rank ?? 0;
      const boost = mode === "body" ? bodyModeScoreBoost(row.title, query) : 0;
      ranked.push({
        result,
        rank: baseRank - boost,
        id: row.id,
        nonApplicable: applies === false,
      });
    }

    // Non-applicable last; within a bucket keep bm25/id order (stable for ties).
    ranked.sort((a, b) => {
      if (a.nonApplicable !== b.nonApplicable) {
        return a.nonApplicable ? 1 : -1;
      }
      if (a.rank !== b.rank) return a.rank - b.rank;
      return a.id - b.id;
    });
    return ranked.slice(0, limit).map((entry) => entry.result);
  }
}

let defaultIndex = new ManualSearchIndex();

export async function searchManual(
  baseUrl: string,
  vehicleRootPath: string,
  query: string,
  limit: number,
  mode: ManualSearchMode = "both",
  applicableOnly = false,
): Promise<ManualSearchResult[]> {
  return defaultIndex.search(
    baseUrl,
    vehicleRootPath,
    query,
    limit,
    mode,
    applicableOnly,
  );
}

export function clearManualSearchCache(): void {
  defaultIndex.close();
  defaultIndex = new ManualSearchIndex();
}
