import { test, expect } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { cpus, platform, arch } from "node:os";
import { serveSession, VIEWER_URL } from "../e2e/session";

const base = {
  before: readFileSync("../testdata/large/generated/before.html", "utf8"),
  after: readFileSync("../testdata/large/generated/after.html", "utf8"),
};
const wrap = (s: string) =>
  s
    .replace("<body>", "<body><section>")
    .replace("</body>", "</section></body>");
const shapes = {
  small: {
    before: "<p>old clause</p><p>unchanged context</p>",
    after: "<p>new clause</p><p>unchanged context</p>",
  },
  aligned: base,
  wrapped: { before: wrap(base.before), after: wrap(base.after) },
  startInsertion: {
    before: base.before,
    after: base.after.replace("<body>", "<body><p>Inserted introduction</p>"),
  },
};
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const p95 = (xs: number[]) =>
  [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * 0.95) - 1];

test("whole-body render, projection, mode and retained-memory benchmark", async ({
  browser,
}) => {
  const report: any = {
    machine: {
      cpu: cpus()[0].model,
      platform: platform(),
      arch: arch(),
      node: process.version,
      browser: browser.version(),
    },
    method:
      "3 cold page navigations and 20 sequential live refreshes per shape; fresh worker for every comparison. Two animation frames to render-ready. Independent native DOM comparison outside timing. Forced GC snapshots are retained JS/DOM, not RSS or worker peaks.",
    rows: [],
    memory: [],
  };
  for (const [name, docs] of Object.entries(shapes)) {
    const row: any = {
      name,
      inputUnits: docs.before.length + docs.after.length,
      hashes: { before: hash(docs.before), after: hash(docs.after) },
      cold: [],
      warm: [],
      modes: [],
    };
    const page = await browser.newPage();
    await serveSession(page, docs);
    await page.addInitScript(() => {
      const NativeWorker = window.Worker;
      (window as any).__workers = { active: 0, requests: [] };
      window.Worker = class extends NativeWorker {
        stopped = false;
        constructor(url: string | URL, options?: WorkerOptions) {
          super(url, options);
          (window as any).__workers.active++;
        }
        postMessage(message: any) {
          (window as any).__workers.requests.push({
            keys: Object.keys(message),
            before: message.before.length,
            after: message.after.length,
          });
          super.postMessage(message);
        }
        terminate() {
          if (!this.stopped) {
            this.stopped = true;
            (window as any).__workers.active--;
          }
          super.terminate();
        }
      };
    });
    for (let i = 0; i < 23; i++) {
      const start = performance.now();
      if (i < 3) await page.goto(VIEWER_URL);
      else await page.evaluate(() => window.__redlineReload!());
      await page.waitForFunction(
        () =>
          document.querySelector(".redline-nav") &&
          (window as any).__workers.active === 0,
      );
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      const readyMs = performance.now() - start;
      const stages = await page.evaluate(() =>
        Object.fromEntries(
          performance
            .getEntriesByType("measure")
            .filter((e) => e.name.startsWith("redline-"))
            .map((e) => [
              e.name,
              { ms: e.duration, detail: (e as PerformanceMeasure).detail },
            ]),
        ),
      );
      (i < 3 ? row.cold : row.warm).push({ readyMs, stages });
      if ([7, 12, 22].includes(i)) {
        const cdp = await page.context().newCDPSession(page);
        await cdp.send("HeapProfiler.collectGarbage");
        report.memory.push({
          name,
          refreshes: i - 2,
          dom: await cdp.send("Memory.getDOMCounters"),
          heap: await cdp.send("Runtime.getHeapUsage"),
        });
        await cdp.detach();
      }
    }
    const requestState = await page.evaluate(() => (window as any).__workers);
    expect(requestState.active).toBe(0);
    expect(requestState.requests).toHaveLength(21); // Last cold navigation plus 20 refreshes.
    expect(
      requestState.requests.every(
        (r: any) => r.keys.sort().join(",") === "after,before",
      ),
    ).toBe(true);
    row.wholeBodyRequests = requestState.requests;
    if (name !== "small") {
      const counts = await page
        .frameLocator("iframe")
        .locator("p")
        .evaluateAll((ps) => ({
          edited: ps.filter(
            (p) =>
              p.hasAttribute("data-diff-op") ||
              p.querySelector("[data-diff-op]"),
          ).length,
          unchanged: ps.filter(
            (p) =>
              !p.querySelector("[data-diff-op]") &&
              !p.hasAttribute("data-diff-op"),
          ).length,
          markedEdited: ps.filter((p) =>
            (p.matches('[data-diff-node="insert"]')
              ? p.textContent
              : [...p.querySelectorAll('[data-diff-node="insert"]')]
                  .map((e) => e.textContent)
                  .join("")
            ).includes("edited"),
          ).length,
        }));
      expect(counts.markedEdited).toBe(120);
      expect(counts.unchanged).toBeGreaterThanOrEqual(5880);
      row.coverage = counts;
    }
    for (const [mode, source] of [
      ["Original", docs.before],
      ["Final", docs.after],
    ] as const) {
      const start = performance.now();
      await page.getByRole("button", { name: mode, exact: true }).click();
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      row.modes.push({ mode, readyMs: performance.now() - start });
      const equal = await page.locator("iframe").evaluate((f, source) => {
        const actual = (f as HTMLIFrameElement).contentDocument!.body.cloneNode(
          true,
        ) as HTMLElement;
        actual
          .querySelectorAll("[data-redline-current]")
          .forEach((e) => e.removeAttribute("data-redline-current"));
        const expected = new DOMParser().parseFromString(
          source,
          "text/html",
        ).body;
        actual.normalize();
        expected.normalize();
        return actual.isEqualNode(expected);
      }, source);
      expect(equal).toBe(true);
    }
    row.p95 = p95(row.warm.map((s: any) => s.readyMs));
    row.targetMs = name === "small" ? 250 : 2000;
    row.targetPassed = row.p95 < row.targetMs;
    report.rows.push(row);
    const cdp = await page.context().newCDPSession(page);
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 10; i++) {
        await page
          .locator("iframe")
          .evaluate((frame) =>
            (frame as HTMLIFrameElement).contentWindow!.scrollTo(0, 500),
          );
        await page
          .getByRole("button", { name: "Original", exact: true })
          .click();
        await page.getByRole("button", { name: "Final", exact: true }).click();
        await page
          .getByRole("button", { name: "Redline", exact: true })
          .click();
      }
      await cdp.send("HeapProfiler.collectGarbage");
      report.memory.push({
        name,
        switches: (round + 1) * 30,
        dom: await cdp.send("Memory.getDOMCounters"),
        heap: await cdp.send("Runtime.getHeapUsage"),
      });
    }
    await page.close();
    writeFileSync(
      "../docs/engine-integration/benchmark-results.json",
      JSON.stringify(report, null, 2) + "\n",
    );
  }
  // Independent views have independent workers/controllers and dispose on page closure.
  const pages = await Promise.all(
    [1, 2, 3].map(async () => {
      const page = await browser.newPage();
      await serveSession(page, shapes.small);
      await page.goto(VIEWER_URL);
      await expect(page.locator(".redline-nav")).toBeVisible();
      return page;
    }),
  );
  report.multipleViews = await Promise.all(
    pages.map(async (p) => {
      const cdp = await p.context().newCDPSession(p);
      await cdp.send("HeapProfiler.collectGarbage");
      return {
        dom: await cdp.send("Memory.getDOMCounters"),
        heap: await cdp.send("Runtime.getHeapUsage"),
      };
    }),
  );
  await Promise.all(pages.map((p) => p.close()));
  writeFileSync(
    "../docs/engine-integration/benchmark-results.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  expect(
    report.rows
      .filter((r: any) => !r.targetPassed)
      .map((r: any) => ({ name: r.name, p95: r.p95, target: r.targetMs })),
  ).toEqual([]);
});
