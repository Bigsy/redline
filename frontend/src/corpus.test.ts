import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { buildRedline } from "./diff";

/**
 * Headless engine verification over the committed synthetic corpus (`testdata/mock/` — fictional
 * "Examplecare" documents, built to exercise the cases the engine was chosen for: boxed TOCs
 * that renumber, endpoint tables gaining/changing rows, prose edits, attribute-only changes).
 * This replaces the gitignored real-customer corpus the engine was originally verified against.
 */

const CORPUS = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "testdata",
  "mock",
);

function pair(name: string): { before: string; after: string } {
  return {
    before: readFileSync(join(CORPUS, "before", `${name}.html`), "utf8"),
    after: readFileSync(join(CORPUS, "after", `${name}.html`), "utf8"),
  };
}

describe("mock corpus", () => {
  it.each(["transaction-guide", "collection-guide", "welcome-pack"])(
    "%s produces a marked redline",
    async (name) => {
      const { before, after } = pair(name);
      const result = await buildRedline(before, after);
      expect(result.markerCount).toBeGreaterThan(0);
    },
  );

  it("transaction guide: renumbered TOC and table changes are marked, not swallowed", async () => {
    const { before, after } = pair("transaction-guide");
    const result = await buildRedline(before, after);

    const doc = new DOMParser().parseFromString(result.html, "text/html");
    const tocMarkers = doc.querySelectorAll(
      "nav.toc [data-diff-node], nav.toc[data-diff-node]",
    );
    expect(tocMarkers.length).toBeGreaterThan(0);
    const insertedText = [...doc.querySelectorAll('[data-diff-node="insert"]')]
      .map((el) => el.textContent)
      .join(" ");
    expect(insertedText).toContain("Rate limits");
    expect(insertedText).toContain("250");
  });

  it("collection guide: the attribute-only callout change is fully represented", async () => {
    const { before, after } = pair("collection-guide");
    const result = await buildRedline(before, after);
    const merged = new DOMParser().parseFromString(result.html, "text/html");
    expect(merged.querySelector(".callout[data-diff-attrs]")).not.toBeNull();
    expect(result.reducedPrecision).toBe(false);
    expect(result.markerCount).toBeGreaterThan(0);
    expect(result.bodyUnderReported).toBe(false);
  });
});
