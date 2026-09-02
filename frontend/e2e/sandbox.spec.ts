import { expect, test, type Frame, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DOC_CSP } from "../src/diff";

/**
 * Sandbox-enforcement proofs in REAL Chromium — the part happy-dom cannot test (viewer.test.ts
 * covers the shell's state machine; here the browser itself must enforce the containment):
 *
 *  - scripts in reviewed documents never execute (iframe sandbox + CSP header), including in the
 *    fallback states that load the RAW, unsanitized document;
 *  - `<meta http-equiv=refresh>` in reviewed input does not navigate the pane (sanitization —
 *    the sandbox does NOT block self-navigation);
 *  - external subresources are blocked (CSP), so reviewed documents cannot phone home;
 *  - `javascript:` links are dead;
 *  - and, with real layout, the minimap/toolbar-bridge geometry that happy-dom measures as zero.
 *
 * The Kotlin scheme handler and navigation guard are mirrored with `page.route()`: Redline-origin
 * requests are fulfilled (session docs carry the same CSP header RedlineWebResources sends, the
 * shell comes from the built bundle), everything else is recorded and aborted. A recorded
 * external request means a containment layer failed even though the guard mirror caught it.
 */

const WEB_DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "main", "resources", "web");
const VIEWER_URL = "http://redline.localhost/index.html?session=test&theme=light";

function contentType(path: string): string {
  if (path.endsWith(".html")) return "text/html";
  if (path.endsWith(".js")) return "application/javascript";
  if (path.endsWith(".css")) return "text/css";
  if (path.endsWith(".map")) return "application/json";
  return "application/octet-stream";
}

async function serveSession(page: Page, docs: { before: string; after: string }): Promise<string[]> {
  const externalRequests: string[] = [];
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== "redline.localhost") {
      externalRequests.push(url.href);
      return route.abort();
    }
    if (url.pathname === "/doc/test/before.html" || url.pathname === "/doc/test/after.html") {
      return route.fulfill({
        contentType: "text/html; charset=utf-8",
        headers: { "Content-Security-Policy": DOC_CSP },
        body: url.pathname.endsWith("before.html") ? docs.before : docs.after,
      });
    }
    const relative = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const file = join(WEB_DIST, relative);
    if (existsSync(file)) {
      return route.fulfill({ contentType: contentType(relative), body: readFileSync(file) });
    }
    return route.fulfill({ status: 404, contentType: "text/plain", body: "not found" });
  });
  return externalRequests;
}

function reviewedFrame(page: Page): Frame {
  const frame = page.frames().find((f) => f !== page.mainFrame());
  if (!frame) throw new Error("reviewed frame not found");
  return frame;
}

const doc = (head: string, body: string) => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

test("scripts in a raw fallback-loaded document never execute, and its subresources cannot phone home", async ({ page }) => {
  // Identical sides -> the shell points the frame at the RAW after.html: no sanitization has
  // touched it, so the sandbox attribute and the CSP response header are the only defenses.
  const hostile = doc(
    "",
    `<h1 id="probe">clean</h1>
     <script>document.getElementById('probe').textContent = 'PWNED by script';</script>
     <img src="missing.png" onerror="document.getElementById('probe').textContent = 'PWNED by handler'">
     <img src="http://evil.example/beacon.png">`,
  );
  const external = await serveSession(page, { before: hostile, after: hostile });

  await page.goto(VIEWER_URL);
  await expect(page.locator(".redline-banner.info")).toContainText("No changes");
  const probe = page.frameLocator("iframe.redline-frame").locator("#probe");
  await expect(probe).toHaveText("clean");
  await page.waitForTimeout(500); // give any pending script/beacon a chance to prove us wrong
  await expect(probe).toHaveText("clean");
  expect(external).toEqual([]);
});

test("meta refresh in reviewed input does not navigate the pane", async ({ page }) => {
  const external = await serveSession(page, {
    before: doc("", "<p>old text</p>"),
    after: doc(
      '<meta http-equiv="refresh" content="0;url=http://evil.example/">',
      "<p>new text</p>",
    ),
  });

  await page.goto(VIEWER_URL);
  await expect(page.frameLocator("iframe.redline-frame").locator("ins.redline")).toHaveCount(1);
  await page.waitForTimeout(1000); // a surviving refresh directive fires immediately after load
  expect(page.url()).toBe(VIEWER_URL);
  expect(external).toEqual([]);
});

test("external subresources in the redline are blocked by the injected CSP", async ({ page }) => {
  const external = await serveSession(page, {
    before: doc("", "<p>old text</p>"),
    after: doc(
      "",
      `<p>new text</p>
       <img src="http://evil.example/pixel.png">
       <link rel="stylesheet" href="http://evil.example/style.css">`,
    ),
  });

  await page.goto(VIEWER_URL);
  await expect(page.frameLocator("iframe.redline-frame").locator("ins.redline").first()).toBeAttached();
  await page.waitForTimeout(500);
  expect(external).toEqual([]);
});

test("javascript: links in the redline are dead", async ({ page }) => {
  await serveSession(page, {
    before: doc("", "<p>old text</p>"),
    after: doc("", `<p>new text</p><a id="jslink" href="javascript:document.body.innerHTML='PWNED'">click</a>`),
  });

  await page.goto(VIEWER_URL);
  const frame = page.frameLocator("iframe.redline-frame");
  await frame.locator("#jslink").click();
  await page.waitForTimeout(300);
  await expect(frame.locator("body")).not.toContainText("PWNED");
  expect(page.url()).toBe(VIEWER_URL);
});

test("the redline is computed in a worker and still produces markers", async ({ page }) => {
  const workerRequests: string[] = [];
  page.on("request", (request) => {
    if (/diff\.worker.*\.js$/.test(new URL(request.url()).pathname)) workerRequests.push(request.url());
  });
  const external = await serveSession(page, {
    before: doc("", "<p>old text</p>"),
    after: doc("", "<p>new text</p>"),
  });

  await page.goto(VIEWER_URL);
  await expect(page.frameLocator("iframe.redline-frame").locator("ins.redline")).toHaveCount(1);
  // The engine chunk must actually load from the bundle — a silent fallback to the main thread
  // would still pass every assertion above while leaving the freeze this batch exists to fix.
  expect(workerRequests).toHaveLength(1);
  expect(external).toEqual([]);
});

test("a document that outruns the time budget shows the give-up banner and the new version", async ({ page }) => {
  // ~22 KB per side of repetitive markup — measured at ~5 s of engine time, against a 50 ms
  // budget. (Repetitive markup is the engine's worst case; this is the cliff batch B exists for.)
  const paragraphs = (marker: string) =>
    Array.from({ length: 400 }, (_, i) => `<p><b>row ${i}</b> <a href="#x">${marker} ${i}</a> filler text</p>`).join("");
  const external = await serveSession(page, {
    before: doc("", paragraphs("old")),
    after: doc("", paragraphs("new")),
  });

  await page.goto(`${VIEWER_URL}&diffTimeoutMs=50`);
  await expect(page.locator(".redline-banner.warning")).toContainText("too large for the rendered redline");
  await expect(page.locator(".redline-banner.warning")).toContainText("gave up after");
  // The document itself is intact: the frame shows the raw after side, not a blank pane.
  await expect(page.frameLocator("iframe.redline-frame").locator("p").first()).toContainText("new 0");
  await expect(page.locator(".redline-cancel")).toHaveCount(0);
  expect(external).toEqual([]);
});

test("with real layout: minimap plots ticks and the toolbar bridge reports and navigates blocks", async ({ page }) => {
  // Stand in for the Kotlin-injected JBCefJSQuery bridge and collect the shell's reports.
  await page.addInitScript(() => {
    const w = window as unknown as { __reports: string[]; __redlineReport: (s: string) => void };
    w.__reports = [];
    w.__redlineReport = (state) => w.__reports.push(state);
  });
  await serveSession(page, {
    before: doc("", `<p>old intro</p><p>${"filler ".repeat(2000)}</p><p>old ending</p>`),
    after: doc("", `<p>new intro</p><p>${"filler ".repeat(2000)}</p><p>new ending</p>`),
  });

  await page.goto(VIEWER_URL);
  // Two far-apart edits -> two change blocks, two minimap ticks, reported over the bridge.
  await expect(page.locator(".redline-tick")).toHaveCount(2);
  const lastReport = () =>
    page.evaluate(() => (window as unknown as { __reports: string[] }).__reports.at(-1));
  expect(await lastReport()).toBe("2,-1");

  // The IDE toolbar drives navigation through window.__redlineNav.
  const frameScrollY = () => reviewedFrame(page).evaluate(() => window.scrollY);
  expect(await frameScrollY()).toBe(0);
  await page.evaluate(() => window.__redlineNav!("next"));
  await expect.poll(lastReport).toBe("2,0");
  await page.evaluate(() => window.__redlineNav!("next"));
  await expect.poll(lastReport).toBe("2,1");
  await expect.poll(frameScrollY).toBeGreaterThan(0);
});
