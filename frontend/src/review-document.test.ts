import { expect, it } from "vitest";
import { compareBodies, renderMerged } from "redline-engine";
import { canonicalBody, projectBody, reviewTargets } from "./review-document";
import { projectionPairs as pairs } from "./projection-fixtures";
import { model2Pairs } from "./model-2-fixtures";
import vectors from "redline-engine/conformance/model-2.json";

for (const vector of vectors)
  it(`shipped model-2 conformance: ${vector.name}`, () => {
    const parse = (html: string) =>
      new DOMParser().parseFromString(html, "text/html").body;
    for (const side of ["before", "after"] as const) {
      const body = parse(vector.mergedHtml);
      projectBody(body, side, vector.dataPrefix);
      expect(canonicalBody(body)).toBe(canonicalBody(parse(vector[side])));
    }
  });

it("custom prefixes preserve other namespaces and complete ordered attributes", () => {
  const body = document.createElement("body");
  body.innerHTML = `<p class="new" data-diff-attrs="ordinary" data-review-attrs='[["id","old"],["data-diff-attrs","keep"],["title",""]]' data-review-op="op-1">same</p>`;
  expect(reviewTargets(body, "review")[0].kind).toBe("attrs");
  const targets = projectBody(body, "before", "review");
  expect(
    [...body.firstElementChild!.attributes].map((a) => [a.name, a.value]),
  ).toEqual([
    ["id", "old"],
    ["data-diff-attrs", "keep"],
    ["title", ""],
  ]);
  expect(targets[0].kind).toBe("attrs");
  expect(targets[0].description).toContain('class: (absent) → "new"');
});
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

for (const fixture of model2Pairs)
  it(`model 2 precision and exact projection: ${fixture.name}`, () => {
    for (const swapped of [false, true]) {
      const before = swapped ? fixture.after : fixture.before;
      const after = swapped ? fixture.before : fixture.after;
      const result = compareBodies({ beforeHtml: before, afterHtml: after });
      expect(result.outcome).toBe("success");
      if (result.outcome !== "success") return;
      expect(result.comparison.modelVersion).toBe(2);
      expect(
        result.comparison.diagnostics.filter(
          (d) => d.code === "coarse-replacement",
        ),
      ).toEqual([]);
      const parse = (html: string) =>
        new DOMParser().parseFromString(html, "text/html").body;
      const merged = renderMerged(result.comparison).html;
      const body = parse(merged);
      expect(body.querySelectorAll("[data-diff-lead]")).toHaveLength(
        fixture.leads,
      );
      expect(body.querySelectorAll("[data-diff-attrs]")).toHaveLength(
        fixture.attrs,
      );
      expect(
        body.querySelectorAll("ul[data-diff-node], tbody[data-diff-node]"),
      ).toHaveLength(0);
      for (const [side, source] of [
        ["before", before],
        ["after", after],
      ] as const) {
        const projected = parse(merged);
        const targets = projectBody(projected, side);
        expect(canonicalBody(projected)).toBe(canonicalBody(parse(source)));
        expect(targets.filter((t) => t.kind === "attrs")).toHaveLength(
          fixture.attrs,
        );
      }
    }
  });
