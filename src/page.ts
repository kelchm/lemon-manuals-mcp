import TurndownService from "turndown";

export const DEFAULT_MAX_BYTES = 40_000;
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const TRUNCATION_MARKER =
  "[truncated — refetch with higher max_bytes or narrower depth]";

export interface PageLink {
  title: string;
  path: string;
  breadcrumb: string[];
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
      links.push({ title, path, breadcrumb: breadcrumbFor(node) });

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

async function fetchHtmlPage(baseUrl: string, path: string): Promise<HtmlPage> {
  const url = backendUrl(baseUrl, path);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  }
  const contentType = res.headers.get("content-type") ?? "unknown";
  if (!contentType.includes("text/html")) {
    throw new Error(
      `GET ${url} returned ${contentType}; use get_image for image paths.`,
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
        targetMarkdown = `[resolution failed: ${error instanceof Error ? error.message : String(error)}]`;
      }
      markdown =
        `## Stub page\n\n${stub.markdown}\n\n` +
        `---\n\n## Stub page → resolved target: \`${targetPath}\`\n\n` +
        targetMarkdown;
    }
  }
  return { ...stub, markdown: truncateMarkdown(markdown, maxBytes) };
}

export async function fetchImage(
  baseUrl: string,
  path: string,
): Promise<ImageResult> {
  const url = backendUrl(baseUrl, path);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  }

  const rawContentType = res.headers.get("content-type") ?? "unknown";
  const mimeType = rawContentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (!mimeType.startsWith("image/")) {
    throw new Error(
      `GET ${url} returned ${rawContentType}, not an image. ` +
        "Use get_page for HTML/manual paths and get_image only for image-link paths.",
    );
  }

  const statedSize = Number(res.headers.get("content-length"));
  if (Number.isFinite(statedSize) && statedSize > MAX_IMAGE_BYTES) {
    throw new Error(
      `Image is ${statedSize} bytes, above the ${MAX_IMAGE_BYTES}-byte (2 MB) limit. ` +
        `View it on the website instead: ${url}`,
    );
  }

  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(
      `Image is ${bytes.byteLength} bytes, above the ${MAX_IMAGE_BYTES}-byte (2 MB) limit. ` +
        `View it on the website instead: ${url}`,
    );
  }
  return { data: Buffer.from(bytes).toString("base64"), mimeType };
}
