import { test, expect } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { serveSession, VIEWER_URL } from "../e2e/session";
test("committed small corpus render-ready p95", async ({ browser }) => {
  const rows = [];
  for (const name of [
    "transaction-guide",
    "collection-guide",
    "welcome-pack",
  ]) {
    const docs = {
      before: readFileSync(`../testdata/mock/before/${name}.html`, "utf8"),
      after: readFileSync(`../testdata/mock/after/${name}.html`, "utf8"),
    };
    const page = await browser.newPage();
    await serveSession(page, docs);
    await page.route("**/doc/test/assets/*", (route) =>
      route.fulfill({
        body: readFileSync(
          `../testdata/mock/after/assets/${new URL(route.request().url()).pathname.split("/").at(-1)}`,
        ),
        contentType: route.request().url().endsWith(".css")
          ? "text/css"
          : "image/svg+xml",
      }),
    );
    const samples = [];
    for (let i = 0; i < 23; i++) {
      const start = performance.now();
      if (i < 3) await page.goto(VIEWER_URL);
      else await page.evaluate(() => window.__redlineReload!());
      await expect(page.locator(".redline-nav")).toBeVisible();
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      samples.push(performance.now() - start);
    }
    const sorted = samples.slice(3).sort((a, b) => a - b);
    rows.push({
      name,
      units: docs.before.length + docs.after.length,
      hashes: Object.fromEntries(
        Object.entries(docs).map(([k, v]) => [
          k,
          createHash("sha256").update(v).digest("hex"),
        ]),
      ),
      cold: samples.slice(0, 3),
      warm: samples.slice(3),
      p95: sorted[18],
    });
    await page.close();
  }
  writeFileSync(
    "../docs/engine-integration/corpus-performance.json",
    JSON.stringify({ browser: browser.version(), timingTargetsAdvisory: true, targetMs: 250, rows }, null, 2) + "\n",
  );
  const slow = rows.filter((r) => r.p95 >= 250);
  if (slow.length) console.warn("Advisory corpus timing target exceeded:", slow);
});
