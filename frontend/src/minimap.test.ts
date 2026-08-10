import { describe, expect, it } from "vitest";

import { clusterMarkers, type MarkerRect } from "./minimap";

const ins = (top: number, height = 20): MarkerRect => ({ top, height, kind: "ins" });
const del = (top: number, height = 20): MarkerRect => ({ top, height, kind: "del" });

describe("clusterMarkers", () => {
  it("returns no blocks for no markers", () => {
    expect(clusterMarkers([])).toEqual([]);
  });

  it("merges markers within the gap into one block", () => {
    const blocks = clusterMarkers([ins(0), ins(100), ins(250)]); // gaps of 80 and 130 ≤ 200
    expect(blocks).toEqual([{ top: 0, bottom: 270, kind: "ins" }]);
  });

  it("starts a new block when the gap exceeds the threshold", () => {
    const blocks = clusterMarkers([ins(0), ins(500)]); // gap of 480 > 200
    expect(blocks).toEqual([
      { top: 0, bottom: 20, kind: "ins" },
      { top: 500, bottom: 520, kind: "ins" },
    ]);
  });

  it("measures the gap from the block's bottom, not its start", () => {
    // A tall marker: the next one is 350 below its TOP but only 50 below its BOTTOM.
    const blocks = clusterMarkers([ins(0, 300), ins(350)]);
    expect(blocks).toHaveLength(1);
  });

  it("skips zero-height markers (display:none content plots phantom blocks)", () => {
    const blocks = clusterMarkers([ins(0, 0), del(500)]);
    expect(blocks).toEqual([{ top: 500, bottom: 520, kind: "del" }]);
  });

  it("marks blocks containing both kinds as mixed", () => {
    const blocks = clusterMarkers([ins(0), del(50), ins(600)]);
    expect(blocks.map((b) => b.kind)).toEqual(["mixed", "ins"]);
  });

  it("sorts unordered markers before clustering", () => {
    const blocks = clusterMarkers([ins(600), del(0)]);
    expect(blocks.map((b) => b.top)).toEqual([0, 600]);
  });

  it("does not let an overlapping earlier marker shrink the block", () => {
    // Second marker sits inside the first's range; block bottom must stay at the max.
    const blocks = clusterMarkers([ins(0, 400), ins(100, 20)]);
    expect(blocks).toEqual([{ top: 0, bottom: 400, kind: "ins" }]);
  });
});
