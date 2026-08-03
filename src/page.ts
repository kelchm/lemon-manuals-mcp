import { createDocument } from "@mixmark-io/domino";
import TurndownService from "turndown";
import { PublicError, errorDetail } from "./errors.js";

export const DEFAULT_MAX_BYTES = 40_000;
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const TRUNCATION_MARKER =
  "[truncated — refetch with higher max_bytes or narrower depth]";

/** Yield every N anchors so long repair-tree walks do not starve /healthz. */
const LINK_WALK_YIELD_EVERY = 500;

export interface PageLink {
  title: string;
  path: string;
  breadcrumb: string[];
  childCount: number;
}

export interface PageResult {
  markdown: string;
  contentType: string;
  links: PageLink[];
  imagePaths: string[];
}

export interface ImageResult {
  data: string;
  mimeType: string;
}

export interface ImageDimensions {
  width: number;
  height: number;
}

interface HtmlPage {
  html: string;
  contentType: string;
  url: string;
}

const LIST_NODE_NAMES = new Set(["OL", "UL"]);
const APPLICABILITY_PATTERN =
  /\b(?:from|through)\s+(?:\d{2}\.\d{2}|MY\s+\d{4})\b/gi;

/** Prefix an opaque site path with the backend URL without decoding it. */
export function backendUrl(baseUrl: string, path: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const separator = path.startsWith("/") ? "" : "/";
  return `${base}${separator}${path}`;
}

/** Resolve an HTML link and express it as one absolute, encoded site path. */
export function normalizeSitePath(href: string, pageUrl: string): string {
  const resolved = new URL(href, pageUrl);
  let pathname = resolved.pathname;
  if (pathname === "/hyperlink") {
    pathname = "/";
  } else if (pathname.startsWith("/hyperlink/")) {
    pathname = pathname.slice("/hyperlink".length);
  }
  return `${pathname}${resolved.search}${resolved.hash}`;
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function elementChildren(node: HTMLElement): HTMLElement[] {
  return Array.from(node.children) as HTMLElement[];
}

function parentList(node: HTMLElement): HTMLElement | null {
  let parent = node.parentElement as HTMLElement | null;
  while (parent) {
    if (LIST_NODE_NAMES.has(parent.nodeName)) return parent;
    parent = parent.parentElement as HTMLElement | null;
  }
  return null;
}

function ownAnchor(node: HTMLElement): HTMLElement | null {
  for (const child of elementChildren(node)) {
    if (
      child.nodeName === "A" &&
      (child.getAttribute("href") || child.getAttribute("name"))
    ) {
      return child;
    }
    if (LIST_NODE_NAMES.has(child.nodeName)) continue;
    const nested = ownAnchor(child);
    if (nested) return nested;
  }
  return null;
}

function directChildLists(node: HTMLElement): HTMLElement[] {
  const lists: HTMLElement[] = [];
  for (const child of elementChildren(node)) {
    if (LIST_NODE_NAMES.has(child.nodeName)) {
      lists.push(child);
    } else if (child.nodeName !== "LI") {
      lists.push(...directChildLists(child));
    }
  }
  return lists;
}

function directListItems(list: HTMLElement): HTMLElement[] {
  return elementChildren(list).filter((child) => child.nodeName === "LI");
}

function isDirectoryTree(root: HTMLElement): boolean {
  const items = Array.from(root.getElementsByTagName("li")) as HTMLElement[];
  return items.length > 0 && items.every((item) => ownAnchor(item) !== null);
}

function breadcrumbFor(anchor: HTMLElement): string[] {
  const reversed: string[] = [];
  let current = anchor.parentElement as HTMLElement | null;
  while (current) {
    if (current.nodeName === "LI") {
      const titleAnchor = ownAnchor(current);
      if (titleAnchor) {
        const title = cleanText(titleAnchor.textContent ?? "");
        if (title && reversed.at(-1) !== title) reversed.push(title);
      }
    }
    current = current.parentElement as HTMLElement | null;
  }
  reversed.reverse();
  return reversed;
}

function childCountFor(anchor: HTMLElement): number {
  let item = anchor.parentElement as HTMLElement | null;
  while (item && item.nodeName !== "LI") {
    item = item.parentElement as HTMLElement | null;
  }
  if (!item) return 0;
  return directChildLists(item).reduce(
    (count, list) => count + directListItems(list).length,
    0,
  );
}

function applicability(title: string): string | undefined {
  const matches = title.match(APPLICABILITY_PATTERN);
  return matches?.join("; ");
}

function escapeLinkTitle(title: string): string {
  return title.replace(/"/g, '\\"');
}

function appendChildCount(content: string, childCount: number): string {
  if (childCount === 0) return content;
  const suffix = ` (${childCount} ${childCount === 1 ? "child" : "children"})`;
  const firstNewline = content.indexOf("\n");
  if (firstNewline === -1) return `${content.trimEnd()}${suffix}`;
  return `${content.slice(0, firstNewline).trimEnd()}${suffix}${content.slice(firstNewline)}`;
}

export function convertHtmlToMarkdown(
  html: string,
  pageUrl: string,
  depth = 1,
): PageResult {
  const links: PageLink[] = [];
  const imagePaths: string[] = [];
  const treeRoots = new WeakMap<HTMLElement, HTMLElement | null>();
  const treeRootValidity = new WeakMap<HTMLElement, boolean>();

  const getTreeRoot = (list: HTMLElement): HTMLElement | null => {
    const cached = treeRoots.get(list);
    if (cached !== undefined) return cached;

    let root = list;
    let ancestor = parentList(root);
    while (ancestor) {
      root = ancestor;
      ancestor = parentList(root);
    }
    let valid = treeRootValidity.get(root);
    if (valid === undefined) {
      valid = isDirectoryTree(root);
      treeRootValidity.set(root, valid);
    }
    const result = valid ? root : null;
    treeRoots.set(list, result);
    return result;
  };

  const listDepth = (list: HTMLElement, root: HTMLElement): number => {
    let current: HTMLElement | null = list;
    let level = 1;
    while (current && current !== root) {
      current = parentList(current);
      level += 1;
    }
    return level;
  };

  const turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
  });
  // Turndown treats an existing backslash as Markdown syntax to escape. Manual
  // titles use it literally (for example, "Diagram 32\6"), so retain one.
  const defaultEscape = turndown.escape.bind(turndown);
  turndown.escape = (value: string): string =>
    defaultEscape(value).replace(/\\\\/g, "\\");

  turndown.addRule("normalizedLink", {
    filter: (node) =>
      node.nodeName === "A" &&
      Boolean(node.getAttribute("href") || node.getAttribute("name")),
    replacement: (content, node) => {
      const linkPath = node.getAttribute("href") ?? node.getAttribute("name");
      if (!linkPath) return content;
      const path = normalizeSitePath(linkPath, pageUrl);
      const title = cleanText(node.textContent ?? "");
      links.push({
        title,
        path,
        breadcrumb: breadcrumbFor(node),
        childCount: childCountFor(node),
      });

      const scope = applicability(title);
      const annotated = scope
        ? `${content} ⚠ applicability: ${scope}`
        : content;
      const linkTitle = cleanText(node.getAttribute("title") ?? "");
      const titlePart = linkTitle ? ` "${escapeLinkTitle(linkTitle)}"` : "";
      return `[${annotated}](<${path}>${titlePart})`;
    },
  });

  turndown.addRule("normalizedImage", {
    filter: "img",
    replacement: (_content, node) => {
      if (node.classList.contains("folder-icon")) return "";
      const src = node.getAttribute("src");
      if (!src) return "";
      const path = normalizeSitePath(src, pageUrl);
      imagePaths.push(path);
      const alt = turndown.escape(cleanText(node.getAttribute("alt") ?? ""));
      const imageTitle = cleanText(node.getAttribute("title") ?? "");
      const titlePart = imageTitle
        ? ` "${escapeLinkTitle(imageTitle)}"`
        : "";
      return `![${alt}](<${path}>${titlePart})`;
    },
  });

  turndown.addRule("directoryTreeList", {
    filter: (node) =>
      LIST_NODE_NAMES.has(node.nodeName) && getTreeRoot(node) !== null,
    replacement: (content, node) => {
      const root = getTreeRoot(node);
      if (!root || listDepth(node, root) > depth) return "";
      const parent = node.parentNode;
      if (parent?.nodeName === "LI" && parent.lastElementChild === node) {
        return `\n${content}`;
      }
      return `\n\n${content}\n\n`;
    },
  });

  turndown.addRule("directoryTreeItem", {
    filter: (node) =>
      node.nodeName === "LI" &&
      node.parentElement !== null &&
      LIST_NODE_NAMES.has(node.parentElement.nodeName) &&
      getTreeRoot(node.parentElement) !== null,
    replacement: (content, node, options) => {
      const parent = node.parentElement;
      if (!parent) return content;
      const root = getTreeRoot(parent);
      if (!root || listDepth(parent, root) > depth) return "";

      const childCount = directChildLists(node).reduce(
        (count, list) => count + directListItems(list).length,
        0,
      );
      const isParagraph = /\n$/.test(content);
      let itemContent = content.replace(/^\n+|\n+$/g, "");
      itemContent = appendChildCount(itemContent, childCount);
      if (isParagraph) itemContent += "\n";

      let prefix = `${options.bulletListMarker ?? "*"}   `;
      if (parent.nodeName === "OL") {
        const start = parent.getAttribute("start");
        const index = elementChildren(parent).indexOf(node);
        prefix = `${start ? Number(start) + index : index + 1}.  `;
      }
      itemContent = itemContent.replace(/\n/g, `\n${" ".repeat(prefix.length)}`);
      return `${prefix}${itemContent}${node.nextSibling ? "\n" : ""}`;
    },
  });

  // Navigation chrome and scripts add noise, not content.
  turndown.remove(["script", "style"]);
  const markdown = turndown.turndown(html);
  return { markdown, contentType: "text/html", links, imagePaths };
}

/**
 * Collect directory-tree links by walking the DOM only — no Turndown, no
 * markdown string. Must match convertHtmlToMarkdown(...).links for the same input
 * except title whitespace: Turndown collapses whitespace across block children
 * before its rules run (e.g. "BrakeSystemRepair"), while this reads the live DOM
 * and keeps word boundaries ("Brake System Repair"). The index is rebuilt from
 * scratch, so the more correct uncollapsed titles are intentional.
 */
export async function extractTreeLinks(
  html: string,
  pageUrl: string,
): Promise<PageLink[]> {
  // Same wrapper Turndown uses so head/body reparenting cannot scramble anchors.
  const doc = createDocument(
    `<x-turndown id="turndown-root">${html}</x-turndown>`,
  );
  const root = doc.getElementById("turndown-root") ?? doc.body ?? doc;
  const anchors = Array.from(root.getElementsByTagName("a")) as HTMLElement[];
  const links: PageLink[] = [];
  for (let i = 0; i < anchors.length; i++) {
    if (i > 0 && i % LINK_WALK_YIELD_EVERY === 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    const node = anchors[i]!;
    // HTML anchors are "A"; SVG <a> stays lowercase — Turndown only collected HTML.
    if (node.nodeName !== "A") continue;
    const linkPath = node.getAttribute("href") ?? node.getAttribute("name");
    if (!linkPath) continue;
    links.push({
      title: cleanText(node.textContent ?? ""),
      path: normalizeSitePath(linkPath, pageUrl),
      breadcrumb: breadcrumbFor(node),
      childCount: childCountFor(node),
    });
  }
  return links;
}

async function fetchHtmlPage(baseUrl: string, path: string): Promise<HtmlPage> {
  const url = backendUrl(baseUrl, path);
  let res: Response;
  try {
    res = await fetch(url);
  } catch (cause) {
    throw new PublicError(
      "The manual page could not be reached. Try again later.",
      `GET ${url} failed: ${errorDetail(cause)}`,
      { cause },
    );
  }
  if (!res.ok) {
    throw new PublicError(
      `The manual page is unavailable (upstream returned ${res.status}). Verify the opaque path came from this server.`,
      `GET ${url} -> ${res.status} ${res.statusText}`,
    );
  }
  const contentType = res.headers.get("content-type") ?? "unknown";
  if (!contentType.includes("text/html")) {
    throw new PublicError(
      "This path is not a manual page. Use get_image for image paths.",
      `GET ${url} returned ${contentType}; expected text/html`,
    );
  }
  const html = await res.text();
  // Drop header/footer chrome; keep breadcrumbs out of the content.
  const main = html.match(
    /<div class="main">([\s\S]*?)<div class="theme-colors footer">/,
  );
  return { html: main?.[1] ?? html, contentType, url };
}

export async function fetchPage(
  baseUrl: string,
  path: string,
  depth = 1,
): Promise<PageResult> {
  const page = await fetchHtmlPage(baseUrl, path);
  const converted = convertHtmlToMarkdown(page.html, page.url, depth);
  return { ...converted, contentType: page.contentType };
}

/** Fetch a repair-tree page and return only its links (no markdown conversion). */
export async function fetchTreeLinks(
  baseUrl: string,
  path: string,
): Promise<PageLink[]> {
  const page = await fetchHtmlPage(baseUrl, path);
  return extractTreeLinks(page.html, page.url);
}

export function truncateMarkdown(markdown: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  const encoded = encoder.encode(markdown);
  if (encoded.byteLength <= maxBytes) return markdown;

  const suffix = `\n\n${TRUNCATION_MARKER}`;
  const suffixBytes = encoder.encode(suffix).byteLength;
  if (maxBytes < suffixBytes) {
    throw new Error(`max_bytes must be at least ${suffixBytes}`);
  }

  let end = maxBytes - suffixBytes;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  while (end > 0) {
    try {
      const prefix = decoder.decode(encoded.subarray(0, end)).trimEnd();
      return `${prefix}${suffix}`;
    } catch {
      end -= 1;
    }
  }
  return suffix.trimStart();
}

export async function fetchResolvedPage(
  baseUrl: string,
  path: string,
  depth: number,
  maxBytes: number,
): Promise<PageResult> {
  const stub = await fetchPage(baseUrl, path, depth);
  let markdown = stub.markdown;
  if (stub.markdown.length < 300 && stub.links.length === 1) {
    const targetPath = stub.links[0]?.path;
    if (targetPath) {
      let targetMarkdown: string;
      try {
        const target = await fetchPage(baseUrl, targetPath, depth);
        targetMarkdown = target.markdown;
      } catch (error) {
        console.error(
          `[lemon-mcp] get_page stub resolution failed: ${errorDetail(error)}`,
        );
        targetMarkdown =
          "[resolution failed: the linked manual page is unavailable]";
      }
      markdown =
        `## Stub page\n\n${stub.markdown}\n\n` +
        `---\n\n## Stub page → resolved target: \`${targetPath}\`\n\n` +
        targetMarkdown;
    }
  }
  return { ...stub, markdown: truncateMarkdown(markdown, maxBytes) };
}

/** Resolve a short one-link publisher stub and return only the target content. */
export async function fetchDocumentPage(
  baseUrl: string,
  path: string,
  depth = 1,
): Promise<PageResult> {
  const page = await fetchPage(baseUrl, path, depth);
  if (page.markdown.length >= 300 || page.links.length !== 1) return page;
  const targetPath = page.links[0]?.path;
  return targetPath ? fetchPage(baseUrl, targetPath, depth) : page;
}

export async function fetchImage(
  baseUrl: string,
  path: string,
): Promise<ImageResult> {
  const url = backendUrl(baseUrl, path);
  let res: Response;
  try {
    res = await fetch(url);
  } catch (cause) {
    throw new PublicError(
      "The image could not be reached. Try again later.",
      `GET ${url} failed: ${errorDetail(cause)}`,
      { cause },
    );
  }
  if (!res.ok) {
    throw new PublicError(
      `The image is unavailable (upstream returned ${res.status}). Verify the opaque path came from get_page.`,
      `GET ${url} -> ${res.status} ${res.statusText}`,
    );
  }

  const rawContentType = res.headers.get("content-type") ?? "unknown";
  const mimeType = rawContentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (!mimeType.startsWith("image/")) {
    throw new PublicError(
      "This path is not an image. Use get_image only with an image path returned by get_page.",
      `GET ${url} returned ${rawContentType}; expected image/*`,
    );
  }

  const contentLengthHeader = res.headers.get("content-length");
  const statedSize =
    contentLengthHeader !== null ? Number(contentLengthHeader) : Number.NaN;
  if (Number.isFinite(statedSize) && statedSize > MAX_IMAGE_BYTES) {
    throw new PublicError(
      `Image is ${statedSize} bytes, above the ${MAX_IMAGE_BYTES}-byte (2 MB) limit. ` +
        "No partial image was returned.",
      `GET ${url} declared ${statedSize} bytes, above ${MAX_IMAGE_BYTES}`,
    );
  }

  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength === 0) {
    throw new PublicError(
      "The upstream response claimed to be an image, but its payload is invalid.",
      `GET ${url} returned 0 bytes as ${mimeType}`,
    );
  }
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new PublicError(
      `Image is ${bytes.byteLength} bytes, above the ${MAX_IMAGE_BYTES}-byte (2 MB) limit. ` +
        "No partial image was returned.",
      `GET ${url} contained ${bytes.byteLength} bytes, above ${MAX_IMAGE_BYTES}`,
    );
  }
  if (!hasImageSignature(bytes, mimeType)) {
    throw new PublicError(
      "The upstream response claimed to be an image, but its payload is invalid.",
      `GET ${url} returned ${bytes.byteLength} bytes as ${mimeType} with no matching image signature`,
    );
  }

  const dimensions = parseImageDimensions(bytes, mimeType);
  if (dimensions !== undefined) {
    if (
      dimensions === null ||
      dimensions.width === 0 ||
      dimensions.height === 0
    ) {
      throw new PublicError(
        "The upstream response claimed to be an image, but its payload is invalid.",
        `GET ${url} returned ${bytes.byteLength} bytes as ${mimeType} with unparseable or zero dimensions`,
      );
    }
  }

  const declared =
    Number.isFinite(statedSize) ? String(statedSize) : "unknown";
  const dimLabel =
    dimensions && dimensions.width > 0
      ? `${dimensions.width}x${dimensions.height}`
      : "n/a";
  console.error(
    `[lemon-mcp] get_image served ${bytes.byteLength} bytes (${mimeType}) ` +
      `content-length=${declared} dimensions=${dimLabel}`,
  );
  return { data: Buffer.from(bytes).toString("base64"), mimeType };
}

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

/**
 * Intrinsic dimensions for PNG/JPEG. Returns null when the type is parseable
 * but dimensions cannot be read; undefined for mime types we do not parse.
 */
export function parseImageDimensions(
  bytes: Uint8Array,
  mimeType: string,
): ImageDimensions | null | undefined {
  if (mimeType === "image/png") {
    if (bytes.byteLength < 24) return null;
    // First chunk must be IHDR; a valid signature alone is not enough.
    if (
      bytes[12] !== 0x49 ||
      bytes[13] !== 0x48 ||
      bytes[14] !== 0x44 ||
      bytes[15] !== 0x52
    ) {
      return null;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (mimeType === "image/jpeg" || mimeType === "image/jpg") {
    return parseJpegDimensions(bytes);
  }
  return undefined;
}

function parseJpegDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.byteLength < 4) return null;
  let offset = 2;
  while (offset + 8 < bytes.byteLength) {
    if (bytes[offset] !== 0xff) return null;
    // JPEG allows one or more 0xFF fill bytes before a marker.
    let markerOffset = offset + 1;
    while (markerOffset < bytes.byteLength && bytes[markerOffset] === 0xff) {
      markerOffset += 1;
    }
    if (markerOffset >= bytes.byteLength) return null;
    const marker = bytes[markerOffset]!;
    // Standalone markers without a length field.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset = markerOffset + 1;
      continue;
    }
    if (JPEG_SOF_MARKERS.has(marker)) {
      if (markerOffset + 7 >= bytes.byteLength) return null;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      return {
        height: view.getUint16(markerOffset + 4),
        width: view.getUint16(markerOffset + 6),
      };
    }
    if (markerOffset + 2 >= bytes.byteLength) return null;
    const segmentLength =
      (bytes[markerOffset + 1]! << 8) | bytes[markerOffset + 2]!;
    if (segmentLength < 2) return null;
    offset = markerOffset + 1 + segmentLength;
  }
  return null;
}

/** Reject HTML error bodies and truncated payloads mislabeled as images. */
export function hasImageSignature(bytes: Uint8Array, mimeType: string): boolean {
  if (mimeType === "image/png") {
    return startsWith(bytes, [137, 80, 78, 71, 13, 10, 26, 10]);
  }
  if (mimeType === "image/jpeg" || mimeType === "image/jpg") {
    return startsWith(bytes, [0xff, 0xd8, 0xff]);
  }
  if (mimeType === "image/gif") {
    return new TextDecoder().decode(bytes.subarray(0, 6)) === "GIF87a" ||
      new TextDecoder().decode(bytes.subarray(0, 6)) === "GIF89a";
  }
  if (mimeType === "image/webp") {
    return new TextDecoder().decode(bytes.subarray(0, 4)) === "RIFF" &&
      new TextDecoder().decode(bytes.subarray(8, 12)) === "WEBP";
  }
  if (mimeType === "image/bmp") return startsWith(bytes, [0x42, 0x4d]);
  if (mimeType === "image/tiff") {
    return startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) ||
      startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a]);
  }
  if (mimeType === "image/svg+xml") {
    const prefix = new TextDecoder().decode(bytes.subarray(0, 1024));
    return /<svg(?:\s|>)/i.test(prefix);
  }
  // ICO and ISO-BMFF (AVIF/HEIF) are uncommon here but valid MCP images.
  if (mimeType === "image/x-icon" || mimeType === "image/vnd.microsoft.icon") {
    return startsWith(bytes, [0x00, 0x00, 0x01, 0x00]);
  }
  if (mimeType === "image/avif" || mimeType === "image/heif") {
    return new TextDecoder().decode(bytes.subarray(4, 8)) === "ftyp";
  }
  return bytes.byteLength > 0;
}
