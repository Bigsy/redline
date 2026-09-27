import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import vectors from "redline-engine/conformance/model-2.json" with { type: "json" };
import { model2Pairs } from "../src/model-2-fixtures";
import { serveSession, VIEWER_URL } from "./session";

// Execute the real projector in Chromium without exposing test hooks in the shipped shell.
const projector = ts.transpileModule(
  readFileSync(new URL("../src/review-document.ts", import.meta.url), "utf8"),
  {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  },
).outputText;
for (const vector of vectors)
  test(`shipped conformance in Chromium: ${vector.name}`, async ({ page }) => {
    const equal = await page.evaluate(
      ({ vector, projector }) => {
        const api: any = {};
        new Function("exports", projector)(api);
        const normalize = (root: Node) => {
          root.normalize();
          if (root.nodeType === 1) {
            const el = root as Element;
            const attrs = [...el.attributes].sort((a, b) =>
              a.name.localeCompare(b.name),
            );
            attrs.forEach((attr) => el.removeAttributeNode(attr));
            attrs.forEach((attr) =>
              el.setAttributeNS(attr.namespaceURI, attr.name, attr.value),
            );
            if (el.localName === "template")
              normalize((el as HTMLTemplateElement).content);
          }
          root.childNodes.forEach(normalize);
        };
        return ["before", "after"].map((side) => {
          const actual = new DOMParser().parseFromString(
            vector.mergedHtml,
            "text/html",
          ).body;
          const expected = new DOMParser().parseFromString(
            vector[side as "before" | "after"],
            "text/html",
          ).body;
          api.projectBody(actual, side, vector.dataPrefix);
          normalize(actual);
          normalize(expected);
          return actual.isEqualNode(expected);
        });
      },
      { vector, projector },
    );
    expect(equal).toEqual([true, true]);
  });

for (const fixture of model2Pairs)
  test(`bundled model 2 precision: ${fixture.name}`, async ({ page }) => {
    await serveSession(page, fixture);
    await page.goto(VIEWER_URL);
    await expect(page.locator(".redline-nav")).toBeVisible();
    await expect(page.locator(".redline-banner")).toHaveCount(0);
    const body = page.frameLocator("iframe").locator("body");
    await expect(body.locator("[data-diff-lead]")).toHaveCount(fixture.leads);
    await expect(body.locator("[data-diff-attrs]")).toHaveCount(fixture.attrs);
    await expect(
      body.locator("ul[data-diff-node], tbody[data-diff-node]"),
    ).toHaveCount(0);
    if (fixture.attrs) {
      const marker = body.locator("[data-diff-attrs]");
      await expect(marker).toHaveAttribute(
        "title",
        /Attributes changed:\nclass: "old" → "new"/,
      );
      expect(
        await marker.evaluate((el) => getComputedStyle(el).outlineStyle),
      ).toBe("dashed");
      await expect(page.locator(".redline-tick")).toHaveAttribute(
        "title",
        /Attributes changed:/,
      );
      await expect(body.locator("img")).toHaveCount(0);
      const attributeOnly = fixture.name.startsWith("attribute-only");
      for (const mode of ["Original", "Final", "Redline"]) {
        await page.getByRole("button", { name: mode, exact: true }).click();
        await expect(page.locator(".redline-tick")).toHaveCount(1);
        if (attributeOnly)
          await expect(page.locator(".redline-tick.attrs")).toHaveCount(1);
        await expect(page.locator(".redline-tick")).toHaveAttribute(
          "title",
          /class: "old" → "new"/,
        );
        await page.evaluate(() => window.__redlineNav?.("next"));
        await expect(page.locator(".redline-nav-count")).toHaveText("1 / 1");
        await expect(
          body.locator("[data-redline-current]").first(),
        ).toBeAttached();
      }
    }
  });
