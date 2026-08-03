import { fetchPage, type PageLink } from "./page.js";
import { normalize } from "./vehicles.js";

const CACHE_CAPACITY = 8;
const SINGLE_PAGE_SEGMENT =
  "Repair%20and%20Diagnosis%20%28Single%20Page%29/";

export interface ManualSearchResult {
  title: string;
  path: string;
  snippet: string;
}

interface ManualTitle {
  title: string;
  path: string;
  breadcrumb: string[];
  haystack: string;
}

const titleCache = new Map<string, Promise<ManualTitle[]>>();

export function singlePagePath(vehicleRootPath: string): string {
  const separator = vehicleRootPath.endsWith("/") ? "" : "/";
  return `${vehicleRootPath}${separator}${SINGLE_PAGE_SEGMENT}`;
}

function toManualTitle(link: PageLink): ManualTitle | undefined {
  if (!link.title || link.breadcrumb.length === 0) return undefined;
  return {
    title: link.title,
    path: link.path,
    breadcrumb: link.breadcrumb,
    haystack: normalize(link.title),
  };
}

function cacheSet(key: string, value: Promise<ManualTitle[]>): void {
  titleCache.set(key, value);
  while (titleCache.size > CACHE_CAPACITY) {
    const oldest = titleCache.keys().next().value;
    if (oldest === undefined) break;
    titleCache.delete(oldest);
  }
}

async function loadTitles(
  baseUrl: string,
  vehicleRootPath: string,
): Promise<ManualTitle[]> {
  const cacheKey = `${baseUrl}\n${vehicleRootPath}`;
  const cached = titleCache.get(cacheKey);
  if (cached) {
    titleCache.delete(cacheKey);
    titleCache.set(cacheKey, cached);
    return cached;
  }

  const loading = fetchPage(
    baseUrl,
    singlePagePath(vehicleRootPath),
    Number.MAX_SAFE_INTEGER,
  ).then((page) =>
    page.links.flatMap((link) => {
      const title = toManualTitle(link);
      return title ? [title] : [];
    }),
  );
  cacheSet(cacheKey, loading);
  try {
    return await loading;
  } catch (error) {
    if (titleCache.get(cacheKey) === loading) titleCache.delete(cacheKey);
    throw error;
  }
}

export async function searchManual(
  baseUrl: string,
  vehicleRootPath: string,
  query: string,
  limit: number,
): Promise<ManualSearchResult[]> {
  const tokens = normalize(query).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];

  const titles = await loadTitles(baseUrl, vehicleRootPath);
  const results: ManualSearchResult[] = [];
  for (const title of titles) {
    if (tokens.every((token) => title.haystack.includes(token))) {
      results.push({
        title: title.title,
        path: title.path,
        snippet: title.breadcrumb.join(" › "),
      });
      if (results.length >= limit) break;
    }
  }
  return results;
}

export function clearManualSearchCache(): void {
  titleCache.clear();
}
