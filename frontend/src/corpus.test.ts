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

const CORPUS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testdata", "mock");

function pair(name: string): { before: string; after: string } {
  return {
    before: readFileSync(join(CORPUS, "before", `${name}.html`), "utf8"),
    after: readFileSync(join(CORPUS, "after", `${name}.html`), "utf8"),
  };
}

describe("mock corpus", () => {
  it.each(["transaction-guide", "collection-guide", "welcome-pack"])(
    "%s produces a marked redline",
    (name) => {
      const { before, after } = pair(name);
      const result = buildRedline(before, after);
      expect(result.markerCount).toBeGreaterThan(0);
    },
  );

  it("transaction guide: renumbered TOC and table changes are marked, not swallowed", () => {
    const { before, after } = pair("transaction-guide");
    const result = buildRedline(before, after);

    const doc = new DOMParser().parseFromString(result.html, "text/html");
    const tocMarkers = doc.querySelectorAll("nav.toc ins.redline, nav.toc del.redline");
    expect(tocMarkers.length).toBeGreaterThan(0);
    const insertedText = [...doc.querySelectorAll("ins.redline")].map((el) => el.textContent).join(" ");
    expect(insertedText).toContain("Rate limits");
    expect(insertedText).toContain("250");
  });

  it("collection guide: the attribute-only callout change is flagged as under-reported", () => {
    const { before, after } = pair("collection-guide");
    const result = buildRedline(before, after);
    // The callout's class change (info -> warning) is invisible in the merged body; the marked
    // text edits must not silence the incomplete-highlights signal.
    expect(result.markerCount).toBeGreaterThan(0);
    expect(result.bodyUnderReported).toBe(true);
  });
});
