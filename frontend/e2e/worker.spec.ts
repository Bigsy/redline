import { expect, test } from "@playwright/test";
import { readdirSync } from "node:fs";
import { serveSession, VIEWER_URL } from "./session";
const workerFile = readdirSync("../src/main/resources/web/assets").find((f) =>
  /^diff.worker-.*\.js$/.test(f),
)!;
for (const [name, before, after, outcome, limit] of [
  [
    "dense repeated output expansion",
    "<p>a</p>".repeat(20000),
    "<p>b</p>".repeat(20000),
    "limit",
    "maxOutputUnits",
  ],
  [
    "deep parsing",
    "<div>".repeat(270) + "a" + "</div>".repeat(270),
    "<p>b</p>",
    "limit",
    "maxDepth",
  ],
  [
    "giant unrelated paragraph",
    "<p>" + "a".repeat(200000) + "</p>",
    "<p>" + "b".repeat(200000) + "</p>",
    "success",
    undefined,
  ],
  [
    "input guard",
    "a".repeat(1000001),
    "b".repeat(1000000),
    "limit",
    "maxInputUnits",
  ],
] as const)
  test(`actual packaged worker: ${name}`, async ({ page }) => {
    await serveSession(page, { before: "<p>x</p>", after: "<p>x</p>" });
    await page.goto(VIEWER_URL);
    const result = await page.evaluate(
      async ({ before, after, url }) => {
        const worker = new Worker(url, { type: "module" });
        return await new Promise<any>((resolve, reject) => {
          const timer = setTimeout(() => {
            worker.terminate();
            reject(new Error("worker exceeded host deadline"));
          }, 15000);
          worker.onmessage = (e) => {
            clearTimeout(timer);
            worker.terminate();
            resolve(e.data);
          };
          worker.onerror = (e) => {
            clearTimeout(timer);
            worker.terminate();
            reject(new Error(e.message));
          };
          worker.postMessage({ before, after });
        });
      },
      { before, after, url: `/assets/${workerFile}` },
    );
    expect(result.outcome).toBe(outcome);
    if (limit) expect(result.limit).toBe(limit);
    if (outcome === "success") {
      expect(result.html.length).toBeLessThanOrEqual(2000000);
      expect(result.modelVersion).toBe(1);
      expect(result.operations).toBeUndefined();
      expect(result.timings.totalMs).toBeGreaterThan(0);
    } else expect(result.html).toBeUndefined();
  });

test("unavailable worker shows an explicit safe fallback", async ({ page }) => {
  await serveSession(page, { before: "<p>old</p>", after: "<p>new</p>" });
  await page.addInitScript(() => {
    window.Worker = class {
      constructor() {
        throw new Error("Worker disabled for regression");
      }
    } as any;
  });
  await page.goto(VIEWER_URL);
  await expect(page.locator(".redline-banner.warning")).toContainText(
    "worker unavailable",
  );
  await expect(page.frameLocator("iframe").locator("p")).toHaveText("new");
  await expect(page.locator("iframe")).toHaveAttribute(
    "sandbox",
    "allow-same-origin",
  );
});

test("superseding refresh terminates the active worker and stale content cannot land", async ({
  page,
}) => {
  const docs = { before: "<p>old</p>", after: "<p>first</p>" };
  await serveSession(page, docs);
  await page.addInitScript(() => {
    const Native = Worker;
    (window as any).__workers = {
      active: 0,
      max: 0,
      started: 0,
      terminated: 0,
    };
    window.Worker = class extends Native {
      timer?: ReturnType<typeof setTimeout>;
      ended = false;
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        const s = (window as any).__workers;
        s.started++;
        s.active++;
        s.max = Math.max(s.max, s.active);
      }
      postMessage(data: any) {
        this.timer = setTimeout(() => super.postMessage(data), 400);
      }
      terminate() {
        clearTimeout(this.timer);
        if (!this.ended) {
          this.ended = true;
          const s = (window as any).__workers;
          s.active--;
          s.terminated++;
        }
        super.terminate();
      }
    };
  });
  await page.goto(VIEWER_URL);
  await page.waitForFunction(() => (window as any).__workers.started === 1);
  docs.after = "<p>latest</p>";
  await page.evaluate(() => window.__redlineReload!());
  await expect(page.locator(".redline-nav")).toBeVisible();
  await page.getByRole("button", { name: "Final", exact: true }).click();
  await expect(page.frameLocator("iframe").locator("body")).toHaveText(
    "latest",
  );
  expect(await page.evaluate(() => (window as any).__workers)).toEqual({
    active: 0,
    max: 1,
    started: 2,
    terminated: 2,
  });
});

test("cancel terminates a delayed real worker", async ({ page }) => {
  await serveSession(page, { before: "<p>old</p>", after: "<p>new</p>" });
  await page.addInitScript(() => {
    const Native = Worker;
    window.Worker = class extends Native {
      timer?: ReturnType<typeof setTimeout>;
      postMessage(data: any) {
        this.timer = setTimeout(() => super.postMessage(data), 5000);
      }
      terminate() {
        clearTimeout(this.timer);
        (window as any).__terminated = true;
        super.terminate();
      }
    };
  });
  await page.goto(VIEWER_URL);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator(".redline-banner.warning")).toContainText(
    "cancelled",
  );
  expect(await page.evaluate(() => (window as any).__terminated)).toBe(true);
  await expect(page.frameLocator("iframe").locator("p")).toHaveText("new");
});
