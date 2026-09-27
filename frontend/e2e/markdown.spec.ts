import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { MARKDOWN_VIEWER_URL, serveSession } from "./session";

const DEMO_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "testdata",
  "markdown",
);
const demoBefore = readFileSync(join(DEMO_DIR, "before.md"), "utf8");
const demoAfter = readFileSync(join(DEMO_DIR, "after.md"), "utf8");

/**
 * The demo deliberately exercises Markdown's block shapes rather than the engine's generated
 * marker details. A renderer regression should leave these native elements readable in every
 * projection, even when the engine wraps a changed phrase in several marker nodes.
 */
test("renders the Markdown demo as readable semantic HTML and preserves the three views", async ({
  page,
}) => {
  const external = await serveSession(page, {
    before: demoBefore,
    after: demoAfter,
  });
  await page.goto(MARKDOWN_VIEWER_URL);

  const frame = page.frameLocator("iframe.redline-frame");
  await expect(page.locator(".redline-nav")).toBeVisible();
  await expect(frame.locator("h1")).toHaveText("Examplecare care summary");
  await expect(frame.locator("p").first()).toContainText("Examplecare team");
  await expect(frame.locator("strong, em").first()).toBeAttached();
  await expect(frame.locator("a[href='https://examplecare.test/care-plan']")).toHaveCount(1);
  await expect(frame.locator("blockquote")).toContainText("Review this summary");
  await expect(frame.locator("table")).toBeVisible();
  await expect(frame.locator("table tbody tr").first()).toBeAttached();
  expect(await frame.locator("table tbody tr").count()).toBeGreaterThanOrEqual(3);
  await expect(frame.locator("ul")).toBeVisible();
  expect(await frame.locator("input[type='checkbox']").count()).toBeGreaterThanOrEqual(3);
  await expect(frame.locator("pre code").filter({ hasText: 'review = "reassuring"' })).toHaveCount(1);

  // Frontmatter is metadata, not an accidental heading or table. The changed values remain
  // reviewable in the rendered document's metadata region.
  await expect(frame.locator("h1")).toHaveCount(1);
  await expect(frame.locator("body")).toContainText("published");
  await expect(
    frame.locator(".redline-frontmatter-source ins.redline").filter({ hasText: "Examplecare" }),
  ).toHaveCount(1);

  const count = page.locator(".redline-nav-count");
  await expect(count).toHaveText(/– \/ [1-9][0-9]*/);
  await page.evaluate(() => window.__redlineNav!("next"));
  await expect(count).toHaveText(/1 \/ [1-9][0-9]*/);

  await page.getByRole("button", { name: "Original", exact: true }).click();
  await expect(frame.locator("body")).toContainText("Call the patient tomorrow");
  await expect(frame.locator("body")).not.toContainText("Call the patient today");
  await expect(frame.locator("table tbody tr")).toHaveCount(2);

  await page.getByRole("button", { name: "Final", exact: true }).click();
  await expect(frame.locator("body")).toContainText("Call the patient today");
  await expect(frame.locator("body")).not.toContainText("Call the patient tomorrow");
  await expect(frame.locator(".redline-frontmatter-source")).toContainText("Examplecare Team");
  await expect(frame.locator("table tbody tr")).toHaveCount(3);

  await page.getByRole("button", { name: "Redline", exact: true }).click();
  await expect(frame.locator("pre code").filter({ hasText: 'review = "reassuring"' })).toHaveCount(1);
  // Fenced blocks are intentionally compared as complete atomic replacements by the engine;
  // that may produce the reduced-precision information banner while preserving both blocks.
  await expect(page.locator(".redline-banner.warning")).toHaveCount(0);
  expect(external).toEqual([]);
});

test("Markdown find follows the active projected view", async ({ page }) => {
  const external = await serveSession(page, {
    before: demoBefore,
    after: demoAfter,
  });
  await page.goto(MARKDOWN_VIEWER_URL);
  const frame = page.frameLocator("iframe.redline-frame");

  await page.keyboard.press("ControlOrMeta+f");
  const search = page.locator(".redline-findbar-search");
  const count = page.locator(".redline-findbar-count");
  await search.fill("record any questions");
  await expect(count).toHaveText("1");

  await page.getByRole("button", { name: "Original", exact: true }).click();
  await expect(count).toHaveText("No results");
  await expect(frame.locator("body")).toContainText("tomorrow");

  await page.getByRole("button", { name: "Final", exact: true }).click();
  await expect(count).toHaveText("1");
  await expect(frame.locator("body")).toContainText("record any questions");
  await page.keyboard.press("Escape");
  expect(external).toEqual([]);
});

test("Markdown keeps metadata and table edits at inline precision", async ({ page }) => {
  const before = `---
title: Precision demo
status: draft
---

# Precision demo

| Name | State | Notes |
| --- | --- | --- |
| Alpha | stable | unchanged |
| Beta | pending | old note |
`;
  const after = `---
title: Precision demo
status: published
---

# Precision demo

| Name | State | Notes |
| --- | --- | --- |
| Alpha | stable | unchanged |
| Beta | active | new note |
| Gamma | new | added row |
`;
  const external = await serveSession(page, { before, after });
  await page.goto(MARKDOWN_VIEWER_URL);

  const frame = page.frameLocator("iframe.redline-frame");
  const metadata = frame.locator(".redline-frontmatter");
  const metadataText = metadata.locator(".redline-frontmatter-source");
  await expect(metadataText).toHaveCount(1);
  await expect(metadataText).toContainText("title: Precision demo");
  await expect(metadataText.locator("del.redline")).toContainText("draft");
  await expect(metadataText.locator("ins.redline")).toContainText("published");
  expect(await metadataText.locator("[data-diff-node]").count()).toBeGreaterThan(0);
  await expect(metadataText).not.toHaveAttribute("data-diff-node", /.+/);

  const rows = frame.locator("table tbody tr");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).not.toHaveAttribute("data-diff-node", /.+/);
  await expect(rows.nth(0).locator("[data-diff-node]")).toHaveCount(0);
  await expect(rows.nth(0)).toContainText("unchanged");

  const changedRow = rows.nth(1);
  await expect(changedRow).not.toHaveAttribute("data-diff-node", /.+/);
  // Model 2 does not pair unrelated single-word cells; the changed row remains local,
  // and the notes cell still receives an inline edit around its shared context.
  await expect(changedRow.locator('td[data-diff-node="delete"]')).toHaveText("pending");
  await expect(changedRow.locator('td[data-diff-node="insert"]')).toHaveText("active");
  await expect(changedRow.locator("td").last().locator("del.redline")).toHaveText("old");
  await expect(changedRow.locator("td").last().locator("ins.redline")).toHaveText("new");
  await expect(frame.locator("tbody[data-diff-node]")).toHaveCount(0);
  for (const [mode, cells] of [["Original", ["Beta", "pending", "old note"]],
    ["Final", ["Beta", "active", "new note"]]] as const) {
    await page.getByRole("button", { name: mode, exact: true }).click();
    await expect(rows.nth(1).locator("td")).toHaveText([...cells]);
  }
  expect(external).toEqual([]);
});

test("Markdown raw HTML remains inside the existing security boundary", async ({ page }) => {
  const hostile = `# New care note

<div id="probe">clean</div>
<script>document.getElementById('probe').textContent = 'PWNED';</script>
<img src="https://evil.example/pixel.png" onerror="document.body.dataset.pwned='yes'">
<link rel="stylesheet" href="https://evil.example/style.css">
`;
  const external = await serveSession(page, {
    before: "# Old care note\n\nThe old note.",
    after: hostile,
  });
  await page.goto(MARKDOWN_VIEWER_URL);
  const frame = page.frameLocator("iframe.redline-frame");
  await expect(frame.locator("body")).toContainText("clean");
  const html = await frame.locator("body").innerHTML();
  expect(html).not.toMatch(/<script|onerror/i);
  await page.waitForTimeout(500);
  await expect(frame.locator("body")).not.toHaveAttribute("data-pwned", "yes");
  expect(external).toEqual([]);
});

test("Markdown added, deleted, and identical sides keep their readable fallback", async ({
  page,
}) => {
  const cases = [
    {
      name: "added",
      before: "",
      after: demoAfter,
      banner: "file was added",
      expected: "reassuring",
    },
    {
      name: "deleted",
      before: demoBefore,
      after: "",
      banner: "file was deleted",
      expected: "stable",
    },
    {
      name: "identical",
      before: demoBefore,
      after: demoBefore,
      banner: "No changes",
      expected: "stable",
    },
  ] as const;

  for (const item of cases) {
    // Playwright routes are retained until explicitly removed; each case models a fresh IDE
    // session and must not be shadowed by the previous case's closed-over document pair.
    await page.unroute("**/*");
    const external = await serveSession(page, {
      before: item.before,
      after: item.after,
    });
    await page.goto(MARKDOWN_VIEWER_URL);
    await expect(page.locator(".redline-banner")).toContainText(item.banner);
    const frame = page.frameLocator("iframe.redline-frame");
    await expect(frame.locator("h1")).toHaveText("Examplecare care summary");
    await expect(frame.locator("body")).toContainText(item.expected);
    await expect(frame.locator("table")).toBeVisible();
    expect(external).toEqual([]);
  }
});

test("Markdown live refresh updates the rendered document and follows the IDE theme", async ({
  page,
}) => {
  const docs = {
    before: "# Daily note\n\nOld text.\n",
    after: "# Daily note\n\nNew text.\n\n- [ ] Review today\n",
  };
  const external = await serveSession(page, docs);
  await page.goto(MARKDOWN_VIEWER_URL.replace("theme=light", "theme=dark"));
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const frame = page.frameLocator("iframe.redline-frame");
  await expect(frame.locator("h1")).toHaveText("Daily note");
  await expect(frame.locator("body")).toContainText("New text");

  const darkSurface = await frame.locator("body").evaluate((body) => {
    const style = getComputedStyle(body);
    return { background: style.backgroundColor, color: style.color };
  });
  expect(darkSurface.background).not.toBe("rgb(255, 255, 255)");

  // The IDE can change its LaF while the diff remains open. The shell observer must restamp the
  // reviewed document rather than waiting for a full navigation or live document refresh.
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "light";
  });
  await expect
    .poll(() =>
      page.locator("iframe.redline-frame").evaluate(
        (frame) => frame.contentDocument?.documentElement.dataset.redlineTheme,
      ),
    )
    .toBe("light");
  await expect
    .poll(() =>
      frame.locator("body").evaluate((body) => getComputedStyle(body).backgroundColor),
    )
    .toBe("rgb(255, 255, 255)");

  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
  await expect
    .poll(() =>
      page.locator("iframe.redline-frame").evaluate(
        (frame) => frame.contentDocument?.documentElement.dataset.redlineTheme,
      ),
    )
    .toBe("dark");

  docs.after = "# Daily note\n\nRevised text.\n\n- [x] Review today\n";
  await page.evaluate(() => window.__redlineReload!());
  await expect(frame.locator("body")).toContainText("Revised text");
  await expect(frame.locator("body")).not.toContainText("New text");
  await expect(frame.locator("input[type='checkbox']")).toBeChecked();
  expect(external).toEqual([]);
});

test("Markdown conversion can be cancelled while its packaged worker is running", async ({
  page,
}) => {
  const external = await serveSession(page, {
    before: "# Old note\n\nOld text.\n",
    after: "# New note\n\nNew text.\n",
  });
  await page.addInitScript(() => {
    const Native = Worker;
    window.Worker = class extends Native {
      timer?: ReturnType<typeof setTimeout>;
      postMessage(data: unknown) {
        this.timer = setTimeout(() => super.postMessage(data), 5000);
      }
      terminate() {
        clearTimeout(this.timer);
        super.terminate();
      }
    } as typeof Worker;
  });

  await page.goto(MARKDOWN_VIEWER_URL);
  await expect(page.locator(".redline-cancel")).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator(".redline-banner.warning")).toContainText("cancelled");
  await expect(page.frameLocator("iframe.redline-frame").locator("body")).toContainText(
    "Markdown could not be rendered",
  );
  await expect(page.locator("iframe.redline-frame")).not.toHaveAttribute("src", /.+/);
  expect(external).toEqual([]);
});

test("Markdown conversion timeout shows a safe rendered error document", async ({ page }) => {
  const external = await serveSession(page, {
    before: "# Old note\n\nOld text.\n",
    after: "# New note\n\nNew text.\n",
  });
  await page.addInitScript(() => {
    const Native = Worker;
    window.Worker = class extends Native {
      timer?: ReturnType<typeof setTimeout>;
      postMessage(data: unknown) {
        this.timer = setTimeout(() => super.postMessage(data), 5000);
      }
      terminate() {
        clearTimeout(this.timer);
        super.terminate();
      }
    } as typeof Worker;
  });

  await page.goto(`${MARKDOWN_VIEWER_URL}&diffTimeoutMs=25`);
  await expect(page.locator(".redline-banner.warning")).toContainText(
    "Markdown could not be rendered",
  );
  await expect(page.frameLocator("iframe.redline-frame").locator("body")).toContainText(
    "Markdown could not be rendered",
  );
  await expect(page.locator("iframe.redline-frame")).not.toHaveAttribute("src", /.+/);
  expect(external).toEqual([]);
});

test("Markdown worker unavailability and oversized input fail safely", async ({ page }) => {
  await serveSession(page, {
    before: "# Old note\n",
    after: "# New note\n",
  });
  await page.addInitScript(() => {
    window.Worker = class {
      constructor() {
        throw new Error("Markdown worker disabled for regression");
      }
    } as any;
  });
  await page.goto(MARKDOWN_VIEWER_URL);
  await expect(page.locator(".redline-banner.warning")).toContainText(
    "Markdown could not be rendered",
  );
  await expect(page.frameLocator("iframe.redline-frame").locator("body")).toContainText(
    "Markdown worker unavailable",
  );
  await expect(page.locator("iframe.redline-frame")).not.toHaveAttribute("src", /.+/);

  await page.unroute("**/*");
  const oversized = "# oversized\n\n" + "x".repeat(1_000_001);
  const external = await serveSession(page, { before: oversized, after: oversized + "!" });
  await page.goto(MARKDOWN_VIEWER_URL);
  await expect(page.locator(".redline-banner.warning")).toContainText(
    "Markdown could not be rendered",
  );
  await expect(page.frameLocator("iframe.redline-frame").locator("body")).toContainText(
    "Markdown input limit exceeded",
  );
  await expect(page.locator("iframe.redline-frame")).not.toHaveAttribute("src", /.+/);
  expect(external).toEqual([]);
});

test("superseding Markdown refresh never leaves stale content or overlapping workers", async ({
  page,
}) => {
  const docs = {
    before: "# Old note\n\nOld text.\n",
    after: "# First note\n\nFirst text.\n",
  };
  const external = await serveSession(page, docs);
  await page.addInitScript(() => {
    const Native = Worker;
    (window as any).__markdownWorkers = { active: 0, max: 0, started: 0, terminated: 0 };
    window.Worker = class extends Native {
      timer?: ReturnType<typeof setTimeout>;
      ended = false;
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        const state = (window as any).__markdownWorkers;
        state.started++;
        state.active++;
        state.max = Math.max(state.max, state.active);
      }
      postMessage(data: unknown) {
        this.timer = setTimeout(() => super.postMessage(data), 300);
      }
      terminate() {
        clearTimeout(this.timer);
        if (!this.ended) {
          this.ended = true;
          const state = (window as any).__markdownWorkers;
          state.active--;
          state.terminated++;
        }
        super.terminate();
      }
    } as typeof Worker;
  });

  await page.goto(MARKDOWN_VIEWER_URL);
  await page.waitForFunction(() => (window as any).__markdownWorkers.started >= 1);
  docs.after = "# Latest note\n\nLatest text.\n";
  await page.evaluate(() => window.__redlineReload!());
  await expect(page.frameLocator("iframe.redline-frame").locator("body")).toContainText(
    "Latest text",
  );
  await expect(page.frameLocator("iframe.redline-frame").locator("body")).not.toContainText(
    "First text",
  );
  await expect
    .poll(() => (page as any).evaluate(() => (window as any).__markdownWorkers.active))
    .toBe(0);
  expect(await page.evaluate(() => (window as any).__markdownWorkers.max)).toBe(1);
  expect(external).toEqual([]);
});

test("hostile Markdown fallback sanitizes scripts, refresh, and forged markers", async ({ page }) => {
  const hostile = `# Safe note

<div id="probe">clean</div>
<script>document.getElementById('probe').textContent = 'PWNED';</script>
<meta http-equiv="refresh" content="0;url=https://evil.example/refresh">
<img src="https://evil.example/pixel.png" onerror="document.body.dataset.pwned='yes'" data-diff-op="forged">
`;
  const cases = [
    { before: hostile, after: hostile, banner: "No changes" },
    { before: "", after: hostile, banner: "file was added" },
  ] as const;

  for (const item of cases) {
    await page.unroute("**/*");
    const external = await serveSession(page, item);
    await page.goto(MARKDOWN_VIEWER_URL);
    await expect(page.locator(".redline-banner.info")).toContainText(item.banner);
    const frame = page.frameLocator("iframe.redline-frame");
    await expect(frame.locator("#probe")).toHaveText("clean");
    const html = await frame.locator("body").innerHTML();
    expect(html).not.toMatch(/<script|http-equiv|onerror|data-diff-/i);
    await page.waitForTimeout(500);
    await expect(frame.locator("body")).not.toHaveAttribute("data-pwned", "yes");
    expect(await page.locator("iframe.redline-frame").getAttribute("src")).toBeNull();
    expect(page.url()).toBe(MARKDOWN_VIEWER_URL);
    expect(external).toEqual([]);
  }
});
