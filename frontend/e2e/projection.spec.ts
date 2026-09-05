import { expect, test } from "@playwright/test";
import { projectionPairs } from "../src/projection-fixtures";
import { serveSession, VIEWER_URL } from "./session";

for (const [before, after] of projectionPairs)
  test(`browser projections and targets: ${before}`, async ({ page }) => {
    await serveSession(page, {
      before: `<html><body>${before}</body></html>`,
      after: `<html><body>${after}</body></html>`,
    });
    await page.goto(VIEWER_URL);
    await expect(page.locator(".redline-nav")).toBeVisible();
    for (const [mode, expected] of [
      ["Original", before],
      ["Final", after],
      ["Original", before],
      ["Final", after],
    ]) {
      await page.getByRole("button", { name: mode, exact: true }).click();
      const actual = await page.locator("iframe").evaluate((frame, source) => {
        const doc = (frame as HTMLIFrameElement).contentDocument!;
        // Independent oracle: DOM equality after native text normalization and attribute sorting.
        // Does not call the production projector or canonical tuple encoder.
        const expected = new DOMParser().parseFromString(
          `<html><body>${source}</body></html>`,
          "text/html",
        ).body;
        const actual = doc.body.cloneNode(true) as HTMLElement;
        const normalize = (root: Node) => {
          root.normalize();
          if (root.nodeType === 1) {
            const el = root as Element;
            el.removeAttribute("data-redline-current");
            const attrs = [...el.attributes].sort((a, b) =>
              a.name.localeCompare(b.name),
            );
            attrs.forEach((a) => el.removeAttributeNode(a));
            attrs.forEach((a) =>
              el.setAttributeNS(a.namespaceURI, a.name, a.value),
            );
            if (el.localName === "template")
              normalize((el as HTMLTemplateElement).content);
          }
          root.childNodes.forEach(normalize);
        };
        normalize(actual);
        normalize(expected);
        return {
          equal: actual.isEqualNode(expected),
          markers: actual.querySelectorAll("[data-diff-op]").length,
        };
      }, expected);
      expect(actual).toEqual({ equal: true, markers: 0 });
    }
    await page.getByRole("button", { name: "Redline", exact: true }).click();
    await expect(
      page.frameLocator("iframe").locator("[data-diff-op]").first(),
    ).toBeAttached();
  });

for (const [before, after] of [
  ["<p>hello world</p>", "<p>hello <b>world</b></p>"],
  [
    '<table><tr><td class="old">cell</td></tr></table>',
    '<table><tr><td class="new">cell</td></tr></table>',
  ],
])
  test(`projected hidden targets warn after mode change: ${before}`, async ({
    page,
  }) => {
    const head =
      '<style>html[data-redline-mode="final"] body {display:none}</style>';
    await serveSession(page, { before: head + before, after: head + after });
    await page.goto(VIEWER_URL);
    await expect(page.locator(".redline-nav")).toBeVisible();
    await page.getByRole("button", { name: "Final", exact: true }).click();
    await expect(page.locator(".redline-banner.warning")).toContainText(
      "styles hide",
    );
    await page.getByRole("button", { name: "Original", exact: true }).click();
    await expect(page.locator(".redline-banner.warning")).toHaveCount(0);
    await expect(page.locator(".redline-tick")).toHaveCount(1);
  });

test("nested template metadata and active content are sanitized before the worker", async ({
  page,
}) => {
  const template =
    '<template data-diff-op="spoof"><template><p data-diff-future="x" onclick="bad()">inert</p><script>bad()</script><meta http-equiv="refresh" content="0;url=https://example.com"></template></template>';
  await serveSession(page, {
    before: "<body>" + template + "<p>old</p></body>",
    after: "<body>" + template + "<p>new</p></body>",
  });
  await page.goto(VIEWER_URL);
  await expect(page.locator(".redline-nav")).toBeVisible();
  await page.getByRole("button", { name: "Final", exact: true }).click();
  const html = await page.frameLocator("iframe").locator("body").innerHTML();
  expect(html).not.toMatch(/data-diff-|onclick|<script|http-equiv/);
  expect(html).toContain("inert");
});

test("a late stylesheet hiding projected targets warns even when document height stays fixed", async ({
  page,
}) => {
  const head =
    '<head><style>body{height:2000px}</style><link rel="stylesheet" href="late-hidden.css"></head>';
  await serveSession(page, {
    before: head + "<body><p>hello world</p></body>",
    after: head + "<body><p>hello <b>world</b></p></body>",
  });
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/late-hidden.css", async (route) => {
    await pending;
    await route.fulfill({
      contentType: "text/css",
      body: 'html[data-redline-mode="final"] p {display:none}',
    });
  });
  await page.goto(VIEWER_URL, { waitUntil: "domcontentloaded" });
  await expect(page.locator(".redline-nav")).toBeVisible();
  await page.getByRole("button", { name: "Final", exact: true }).click();
  await expect(page.locator(".redline-banner.warning")).toHaveCount(0);
  release();
  await expect(page.locator(".redline-banner.warning")).toContainText(
    "styles hide",
  );
  await page.getByRole("button", { name: "Original", exact: true }).click();
  await expect(page.locator(".redline-banner.warning")).toHaveCount(0);
});

test("scrolled mode switches do not accumulate load listeners", async ({
  page,
}) => {
  const head = "<style>p{height:1500px}</style>";
  await serveSession(page, {
    before: head + "<p>old text</p>",
    after: head + "<p>new text</p>",
  });
  await page.goto(VIEWER_URL);
  await expect(page.locator(".redline-nav")).toBeVisible();
  const cdp = await page.context().newCDPSession(page);
  const counts = [];
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < 5; i++) {
      await page
        .locator("iframe")
        .evaluate((frame) =>
          (frame as HTMLIFrameElement).contentWindow!.scrollTo(0, 400),
        );
      await page.getByRole("button", { name: "Original", exact: true }).click();
      await page.getByRole("button", { name: "Final", exact: true }).click();
      await page.getByRole("button", { name: "Redline", exact: true }).click();
    }
    await cdp.send("HeapProfiler.collectGarbage");
    counts.push(await cdp.send("Memory.getDOMCounters"));
  }
  expect(counts[2].jsEventListeners).toBe(counts[1].jsEventListeners);
  expect(counts[2].nodes).toBe(counts[1].nodes);
  expect(counts[2].documents).toBe(2);
  expect(
    await page
      .locator("iframe")
      .evaluate((f) => (f as HTMLIFrameElement).contentWindow!.scrollY),
  ).toBeGreaterThan(0);
});
