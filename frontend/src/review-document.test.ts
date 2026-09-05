import { expect, it } from "vitest";
import { compareBodies, renderMerged } from "redline-engine";
import { canonicalBody, projectBody, reviewTargets } from "./review-document";
import { projectionPairs as pairs } from "./projection-fixtures";
for (const [before, after] of pairs)
  it(`projects both sides exactly: ${before}`, () => {
    const result = compareBodies({ beforeHtml: before, afterHtml: after });
    expect(result.outcome).toBe("success");
    if (result.outcome !== "success") return;
    const parse = (html: string) =>
      new DOMParser().parseFromString(html, "text/html").body;
    expect(
      reviewTargets(parse(renderMerged(result.comparison).html)).length,
    ).toBeGreaterThan(0);
    for (const [side, input] of [
      ["before", before],
      ["after", after],
    ] as const) {
      const body = parse(renderMerged(result.comparison).html);
      projectBody(body, side);
      expect(canonicalBody(body)).toBe(canonicalBody(parse(input)));
    }
  });
