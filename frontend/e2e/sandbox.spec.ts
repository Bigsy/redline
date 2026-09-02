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
 *  - and, with real layout, the minimap/toolbar-bridge geometry that happy-dom measures as zero,
 *    plus the in-place re-render a live refresh drives through `window.__redlineReload`.
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

/** Path on the session asset route that answers late, to model a slow document stylesheet. */
const SLOW_CSS = "slow.css";

/**
 * Mirror the Kotlin scheme handler. `docs` is read on every request, so mutating it stands in for
 * [RedlineWebResources.updateSession] — how a live refresh changes what a session serves.
 */
async function serveSession(page: Page, docs: { before: string; after: string }): Promise<string[]> {
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

/**
 * Screenshot the frame once its pixels have settled: two identical shots in a row. The custom
 * highlight repaints asynchronously, so a single shot taken right after a DOM change catches it
 * mid-flight.
 */
async function stableShot(page: Page): Promise<Buffer> {
  let previous = await page.locator("iframe.redline-frame").screenshot();
  for (let attempt = 0; attempt < 20; attempt++) {
    const next = await page.locator("iframe.redline-frame").screenshot();
    if (next.equals(previous)) return next;
    previous = next;
  }
  throw new Error("the frame never stopped repainting");
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

test("a live reload re-renders in place: new markers, and the reader keeps their place", async ({ page }) => {
  // Long enough to scroll: the shell must not send the reader back to the top on every keystroke.
  const filler = `<p>${"filler ".repeat(2000)}</p>`;
  const docs = {
    before: doc("", `<p>old intro</p>${filler}<p>old ending</p>`),
    after: doc("", `<p>new intro</p>${filler}<p>new ending</p>`),
  };
  const external = await serveSession(page, docs);

  const framed = page.frameLocator("iframe.redline-frame");
  // Read through the shell rather than a captured Frame handle: the reload replaces the iframe.
  const frameScrollY = () =>
    page.evaluate(
      () => document.querySelector<HTMLIFrameElement>("iframe.redline-frame")!.contentWindow!.scrollY,
    );

  await page.goto(VIEWER_URL);
  await expect(framed.locator("ins.redline")).toHaveCount(2);

  await page.evaluate(() => {
    document.querySelector<HTMLIFrameElement>("iframe.redline-frame")!.contentWindow!.scrollTo(0, 1200);
  });
  const parkedAt = await frameScrollY();
  expect(parkedAt).toBeGreaterThan(0);

  // Kotlin's side of a live refresh: replace what the session serves, then call the hook.
  docs.after = doc("", `<p>new intro</p>${filler}<p>rewritten ending</p>`);
  await page.evaluate(() => window.__redlineReload!());

  await expect(framed.locator("ins.redline").last()).toContainText("rewritten");
  await expect(framed.locator("ins.redline")).toHaveCount(2);
  // One minimap, not one per reload — the old controller must be torn down with its frame.
  await expect(page.locator(".redline-minimap")).toHaveCount(1);
  await expect(page.locator(".redline-banner")).toHaveCount(0);

  await expect.poll(frameScrollY).toBeGreaterThan(parkedAt - 20);
  expect(await frameScrollY()).toBeLessThan(parkedAt + 20);
  expect(external).toEqual([]);
});

test("the restored scroll offset survives a stylesheet that lands after the redline", async ({ page }) => {
  // Written documents are scrollable at once but unstyled: clamping the offset against that
  // height would drop the reader near the top of a document their own CSS makes 20x taller.
  const body = (ending: string) =>
    `${Array.from({ length: 40 }, (_, i) => `<p>row ${i}</p>`).join("")}<p>${ending} ending</p>`;
  const head = `<link rel="stylesheet" href="${SLOW_CSS}">`;
  const docs = { before: doc(head, body("old")), after: doc(head, body("new")) };
  const external = await serveSession(page, docs);

  const framed = page.frameLocator("iframe.redline-frame");
  const framedRoot = () =>
    page.evaluate(() => {
      const root = document.querySelector<HTMLIFrameElement>("iframe.redline-frame")!.contentDocument!
        .documentElement;
      return { scrollY: root.ownerDocument.defaultView!.scrollY, scrollHeight: root.scrollHeight };
    });

  await page.goto(VIEWER_URL);
  await expect(framed.locator("ins.redline")).toHaveCount(1);
  // Wait for the stylesheet, so the offset below is one only the styled document can hold.
  await expect.poll(async () => (await framedRoot()).scrollHeight).toBeGreaterThan(10_000);
  await page.evaluate(() => {
    document.querySelector<HTMLIFrameElement>("iframe.redline-frame")!.contentWindow!.scrollTo(0, 6000);
  });
  const parkedAt = (await framedRoot()).scrollY;
  expect(parkedAt).toBeGreaterThan(5000);

  docs.after = doc(head, body("rewritten"));
  await page.evaluate(() => window.__redlineReload!());
  await expect(framed.locator("ins.redline")).toContainText("rewritten");

  // The unstyled height is ~800 px, so anything near the old offset proves the restore waited
  // for the stylesheet instead of clamping against the bare document.
  await expect.poll(async () => (await framedRoot()).scrollY).toBeGreaterThan(parkedAt - 100);
  expect(external).toEqual([]);
});

test("with real layout: the counter, the current-block highlight, and the three view modes", async ({ page }) => {
  const filler = `<p>${"filler ".repeat(2000)}</p>`;
  const external = await serveSession(page, {
    // Two far-apart edits, each an insertion AND a deletion, so both sides have something to hide.
    before: doc("", `<p>old intro</p>${filler}<p>old ending</p>`),
    after: doc("", `<p>new intro</p>${filler}<p>new ending</p>`),
  });

  await page.goto(VIEWER_URL);
  const framed = page.frameLocator("iframe.redline-frame");
  await expect(page.locator(".redline-tick")).toHaveCount(2);

  // The counter: no current block until you navigate, then position within the total.
  const counter = page.locator(".redline-nav-count");
  await expect(counter).toHaveText("– / 2");
  await expect(framed.locator("[data-redline-current]")).toHaveCount(0);

  // The current block is marked in the document itself, and the mark MOVES rather than piling up.
  // The engine wraps only the changed words, so identify a block by its containing paragraph.
  const highlightedIn = framed.locator("p:has([data-redline-current])");
  await page.evaluate(() => window.__redlineNav!("next"));
  await expect(counter).toHaveText("1 / 2");
  await expect(highlightedIn).toHaveCount(1);
  await expect(highlightedIn).toContainText("intro");

  await page.evaluate(() => window.__redlineNav!("next"));
  await expect(counter).toHaveText("2 / 2");
  await expect(highlightedIn).toHaveCount(1);
  await expect(highlightedIn).toContainText("ending");

  // View modes, with real layout doing the hiding.
  const visibleMarkers = async () => ({
    ins: await framed.locator("ins.redline:visible").count(),
    del: await framed.locator("del.redline:visible").count(),
  });
  expect(await visibleMarkers()).toEqual({ ins: 2, del: 2 });

  await page.getByRole("button", { name: "Original", exact: true }).click();
  expect(await visibleMarkers()).toEqual({ ins: 0, del: 2 });
  // Deletions are the original document here, so they are shown unmarked.
  await expect(framed.locator("del.redline").first()).toHaveCSS("text-decoration-line", "none");

  await page.getByRole("button", { name: "Final", exact: true }).click();
  expect(await visibleMarkers()).toEqual({ ins: 2, del: 0 });
  await expect(framed.locator("ins.redline").first()).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");

  await page.getByRole("button", { name: "Redline", exact: true }).click();
  expect(await visibleMarkers()).toEqual({ ins: 2, del: 2 });
  // A mode change re-measures: the ticks are back for both sides.
  await expect(page.locator(".redline-tick")).toHaveCount(2);
  await expect(page.locator(".redline-banner")).toHaveCount(0);
  expect(external).toEqual([]);
});

test("find in document: counts, paints, scrolls, and clears", async ({ page }) => {
  // "beta" three times, far apart, plus one occurrence the redline splits across an <ins>.
  const filler = `<p>${"filler ".repeat(1500)}</p>`;
  const external = await serveSession(page, {
    before: doc("", `<p>alpha beta gamma</p>${filler}<p>beta two</p>${filler}<p>the old beta ending</p>`),
    after: doc("", `<p>alpha beta gamma</p>${filler}<p>beta two</p>${filler}<p>the new beta ending</p>`),
  });

  await page.goto(VIEWER_URL);
  const framed = page.frameLocator("iframe.redline-frame");
  await expect(framed.locator("ins.redline")).toHaveCount(1);

  const bar = page.locator(".redline-findbar");
  const count = page.locator(".redline-findbar-count");
  await expect(bar).toBeHidden();

  // The pane has no IDE find bar to fight with; the shortcut is handled in the page.
  await page.keyboard.press("ControlOrMeta+f");
  await expect(bar).toBeVisible();
  await page.locator(".redline-findbar-search").fill("beta");
  await expect(count).toHaveText("3");

  // A phrase that only matches ACROSS the redline's <ins> boundary — the reason matches are
  // built from the document's text rather than one text node at a time.
  const frameScrollY = () =>
    page.evaluate(
      () => document.querySelector<HTMLIFrameElement>("iframe.redline-frame")!.contentWindow!.scrollY,
    );
  await page.locator(".redline-findbar-search").fill("new beta ending");
  await expect(count).toHaveText("1");
  expect(await frameScrollY()).toBe(0);
  await page.keyboard.press("Enter");
  await expect(count).toHaveText("1/1");
  // The match is at the far end of the document: navigating to it must move the frame and, the
  // part that actually matters, leave the match where the reader can see it.
  await expect.poll(frameScrollY).toBeGreaterThan(0);
  await expect(framed.locator("p", { hasText: "beta ending" })).toBeInViewport();

  // The highlight is painted by ::highlight(), which exposes nothing to JS at all — so the only
  // way to prove it painted is pixels. Baseline first, with the bar closed and nothing marked.
  // Both comparisons poll: hiding the bar resolves as soon as the attribute flips, which is
  // before the frame has repainted.
  const shot = () => page.locator("iframe.redline-frame").screenshot();
  const matchesBaseline = async () => (await shot()).equals(baseline);
  await page.keyboard.press("Escape");
  await expect(bar).toBeHidden();
  const baseline = await stableShot(page);

  await page.keyboard.press("ControlOrMeta+f");
  await page.locator(".redline-findbar-search").fill("filler");
  await expect(count).not.toHaveText("No results");
  await expect.poll(matchesBaseline).toBe(false);

  // Closing must restore the frame exactly — which also shows the highlight never touched the
  // document's DOM, the reason for using this API rather than wrapping matches in elements.
  await page.keyboard.press("Escape");
  await expect(bar).toBeHidden();
  await expect.poll(matchesBaseline).toBe(true);
  expect(external).toEqual([]);
});

test("find skips matches the current view mode hides", async ({ page }) => {
  const external = await serveSession(page, {
    before: doc("", "<p>the removed clause stays</p>"),
    after: doc("", "<p>the inserted clause stays</p>"),
  });

  await page.goto(VIEWER_URL);
  const framed = page.frameLocator("iframe.redline-frame");
  await expect(framed.locator("del.redline")).toHaveCount(1);

  await page.keyboard.press("ControlOrMeta+f");
  await page.locator(".redline-findbar-search").fill("removed");
  const count = page.locator(".redline-findbar-count");
  await expect(count).toHaveText("1");

  // "Final" hides deletions, so a hit inside one is unreachable — offering it would send the
  // reader scrolling after text that is not on screen. The count must follow the mode BY ITSELF:
  // re-typing the query here would test the search and hide whether the mode change reaches it.
  await page.getByRole("button", { name: "Final", exact: true }).click();
  await expect(count).toHaveText("No results");

  await page.getByRole("button", { name: "Redline", exact: true }).click();
  await expect(count).toHaveText("1");

  // And navigation must not land on a hidden match either.
  await page.getByRole("button", { name: "Final", exact: true }).click();
  await page.keyboard.press("Enter");
  await expect(count).toHaveText("No results");
  expect(external).toEqual([]);
});

test("find works in the fallback states, which never build a redline", async ({ page }) => {
  // Identical sides: the frame is pointed at the RAW after.html and no redline CSS is injected,
  // so the find highlight has to bring its own stylesheet.
  const same = doc("", `<p>alpha beta gamma</p><p>${"filler ".repeat(1500)}</p><p>beta again</p>`);
  const external = await serveSession(page, { before: same, after: same });

  await page.goto(VIEWER_URL);
  await expect(page.locator(".redline-banner.info")).toContainText("No changes");

  await page.keyboard.press("ControlOrMeta+f");
  await page.locator(".redline-findbar-search").fill("beta");
  await expect(page.locator(".redline-findbar-count")).toHaveText("2");
  // The stylesheet the bar injects, in a document that got none of ours.
  await expect(page.frameLocator("iframe.redline-frame").locator("#redline-find-style")).toBeAttached();
  expect(external).toEqual([]);
});

test("a reviewed stylesheet cannot empty a view mode in silence", async ({ page }) => {
  // The reviewed document cannot SET our mode attribute (sanitization refuses it) but it can
  // select on it. This rule leaves Redline looking perfectly honest and empties Final.
  const hostile = "<style>html[data-redline-mode='final'] ins.redline { display: none }</style>";
  const external = await serveSession(page, {
    before: doc(hostile, "<p>the old clause</p>"),
    after: doc(hostile, "<p>the new clause</p>"),
  });

  await page.goto(VIEWER_URL);
  const framed = page.frameLocator("iframe.redline-frame");
  await expect(framed.locator("ins.redline")).toHaveCount(1);
  // Redline mode is genuinely fine, so nothing should be claimed about it.
  await expect(page.locator(".redline-banner")).toHaveCount(0);

  await page.getByRole("button", { name: "Final", exact: true }).click();
  // Every insertion gone and the counter empty — the reader must be told, not left to notice.
  await expect(page.locator(".redline-nav-count")).toHaveText("– / 0");
  await expect(page.locator(".redline-banner.warning")).toContainText("styles hide the changed content");

  // Original shows deletions, which this document does not touch: the warning must retract.
  await page.getByRole("button", { name: "Original", exact: true }).click();
  await expect(page.locator(".redline-banner")).toHaveCount(0);
  expect(external).toEqual([]);
});

test("a reviewed Content-Security-Policy meta cannot disable the redline styling", async ({ page }) => {
  // CSP policies intersect, so a reviewed `style-src 'none'` would kill the injected stylesheet
  // outright: marker colours, the visibility pins and the view-mode rules all at once.
  const external = await serveSession(page, {
    before: doc("", "<p>old text</p>"),
    after: doc('<meta http-equiv="Content-Security-Policy" content="style-src \'none\'">', "<p>new text</p>"),
  });

  await page.goto(VIEWER_URL);
  const framed = page.frameLocator("iframe.redline-frame");
  await expect(framed.locator("ins.redline")).toHaveCount(1);
  // The insertion still carries our background, so REDLINE_CSS survived.
  await expect(framed.locator("ins.redline")).toHaveCSS("background-color", "rgb(211, 242, 211)");
  // …and the mode control still does something.
  await page.getByRole("button", { name: "Original", exact: true }).click();
  expect(await framed.locator("ins.redline:visible").count()).toBe(0);
  expect(external).toEqual([]);
});

test("the surviving side is shown in the document's own colour, not the marker's", async ({ page }) => {
  const dark = "<style>body { background: #202020; color: #eeeeee }</style>";
  const external = await serveSession(page, {
    before: doc(dark, "<p>the old clause</p>"),
    after: doc(dark, "<p>the new clause</p>"),
  });

  await page.goto(VIEWER_URL);
  const framed = page.frameLocator("iframe.redline-frame");
  await expect(framed.locator("del.redline")).toHaveCount(1);

  // In Original the deletion IS the document, so pinning the marker's near-black text colour
  // would leave it all but invisible on this canvas.
  await page.getByRole("button", { name: "Original", exact: true }).click();
  await expect(framed.locator("del.redline")).toHaveCSS("color", "rgb(238, 238, 238)");
  await expect(framed.locator("del.redline")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  // Back in Redline the pin is right again: dark text on the light marker background.
  await page.getByRole("button", { name: "Redline", exact: true }).click();
  await expect(framed.locator("del.redline")).toHaveCSS("color", "rgb(26, 26, 26)");
  expect(external).toEqual([]);
});

test("the reader's view mode survives a live reload", async ({ page }) => {
  const docs = {
    before: doc("", "<p>the old clause</p>"),
    after: doc("", "<p>the new clause</p>"),
  };
  const external = await serveSession(page, docs);

  await page.goto(VIEWER_URL);
  const framed = page.frameLocator("iframe.redline-frame");
  await expect(framed.locator("del.redline")).toHaveCount(1);

  await page.getByRole("button", { name: "Final", exact: true }).click();
  expect(await framed.locator("del.redline:visible").count()).toBe(0);

  // A keystroke in the editor 400 ms earlier. The mode is the reader's, not the render's.
  docs.after = doc("", "<p>the newer clause</p>");
  await page.evaluate(() => window.__redlineReload!());
  await expect(framed.locator("ins.redline")).toContainText("newer");

  await expect(page.getByRole("button", { name: "Final", exact: true })).toHaveAttribute("aria-pressed", "true");
  expect(await framed.locator("del.redline:visible").count()).toBe(0);
  expect(external).toEqual([]);
});
