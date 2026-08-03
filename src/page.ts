import TurndownService from "turndown";

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
});
// Navigation chrome and scripts add noise, not content.
turndown.remove(["script", "style"]);

export interface PageResult {
  markdown: string;
  contentType: string;
}

export async function fetchPage(
  baseUrl: string,
  path: string,
): Promise<PageResult> {
  // Encode each path segment, tolerating both encoded and raw input.
  const encodedPath = path
    .split("/")
    .map((seg) => encodeURIComponent(decodeURIComponent(seg)))
    .join("/");
  const url = new URL(encodedPath, baseUrl);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  }
  const contentType = res.headers.get("content-type") ?? "unknown";
  if (!contentType.includes("text/html")) {
    throw new Error(
      `GET ${url} returned ${contentType}; only HTML pages can be converted. ` +
        "Image paths are for humans via the website.",
    );
  }
  const html = await res.text();
  // Drop header/footer chrome; keep breadcrumbs out of the content.
  const main = html.match(/<div class="main">([\s\S]*?)<div class="theme-colors footer">/);
  const markdown = turndown.turndown(main?.[1] ?? html);
  return { markdown, contentType };
}
