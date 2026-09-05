import type { Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DOC_CSP } from "../src/diff";
const WEB_DIST = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "src",
  "main",
  "resources",
  "web",
);
export const VIEWER_URL =
  "http://redline.localhost/index.html?session=test&theme=light";

function contentType(path: string): string {
  if (path.endsWith(".html")) return "text/html";
  if (path.endsWith(".js")) return "application/javascript";
  if (path.endsWith(".css")) return "text/css";
  if (path.endsWith(".map")) return "application/json";
  return "application/octet-stream";
}

/** Path on the session asset route that answers late, to model a slow document stylesheet. */
export const SLOW_CSS = "slow.css";

/**
 * Mirror the Kotlin scheme handler. `docs` is read on every request, so mutating it stands in for
 * [RedlineWebResources.updateSession] — how a live refresh changes what a session serves.
 */
export async function serveSession(
  page: Page,
  docs: { before: string; after: string },
): Promise<string[]> {
  const externalRequests: string[] = [];
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== "redline.localhost") {
      externalRequests.push(url.href);
      return route.abort();
    }
    if (url.pathname === `/doc/test/${SLOW_CSS}`) {
      // The Kotlin asset route, deliberately late: the document is an order of magnitude taller
      // once this applies, which is the height the scroll restore has to clamp against.
      await new Promise((resolve) => setTimeout(resolve, 300));
      return route.fulfill({
        contentType: "text/css",
        headers: { "Content-Security-Policy": DOC_CSP },
        body: "p { height: 400px; margin: 0 }",
      });
    }
    if (
      url.pathname === "/doc/test/before.html" ||
      url.pathname === "/doc/test/after.html"
    ) {
      return route.fulfill({
        contentType: "text/html; charset=utf-8",
        headers: { "Content-Security-Policy": DOC_CSP },
        body: url.pathname.endsWith("before.html") ? docs.before : docs.after,
      });
    }
    const relative =
      url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const file = join(WEB_DIST, relative);
    if (existsSync(file)) {
      return route.fulfill({
        contentType: contentType(relative),
        body: readFileSync(file),
      });
    }
    return route.fulfill({
      status: 404,
      contentType: "text/plain",
      body: "not found",
    });
  });
  return externalRequests;
}
