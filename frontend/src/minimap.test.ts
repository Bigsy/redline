import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clusterMarkers,
  installMinimap,
  type MarkerKind,
  type MarkerRect,
  type MinimapController,
} from "./minimap";

const ins = (top: number, height = 20): MarkerRect => ({
  top,
  height,
  kind: "ins",
});
const del = (top: number, height = 20): MarkerRect => ({
  top,
  height,
  kind: "del",
});
const block = (top: number, bottom: number, kind: MarkerKind | "mixed") => ({
  top,
  bottom,
  kind,
  elements: [],
  ranges: [],
  operations: [],
});

/**
 * The counter, the current-block highlight and the view modes need geometry, and happy-dom has
 * none — every marker measures 0×0 and clusters to nothing. `measureMarkers` reads only
 * `getBoundingClientRect`, so stubbing that per element is enough to exercise the real
 * plotting/navigation/highlight path headlessly. (Real-layout coverage is the Playwright suite's.)
 */
function fakeRect(top: number, height: number): () => DOMRect {
  return () =>
    ({
      top,
      height,
      bottom: top + height,
      left: 0,
      right: 10,
      width: 10,
      x: 0,
      y: top,
    }) as DOMRect;
}

function withFakedLayout(
  markers: { kind: MarkerKind; top: number; height: number }[],
): {
  container: HTMLElement;
  frame: HTMLIFrameElement;
  doc: Document;
} {
  document.body.innerHTML =
    '<div id="app"><div class="redline-content"></div></div>';
  const container = document.querySelector<HTMLElement>(".redline-content")!;
  const frame = document.createElement("iframe");
  container.appendChild(frame);
  const doc = frame.contentDocument!;
  doc.body.innerHTML = markers
    .map((m) =>
      m.kind === "ins"
        ? '<ins class="redline" data-diff-op="op-i" data-diff-node="insert">new</ins>'
        : '<del class="redline" data-diff-op="op-d" data-diff-node="delete">old</del>',
    )
    .join("<p>filler</p>");
  Object.defineProperty(doc.documentElement, "getBoundingClientRect", {
    configurable: true,
    value: fakeRect(0, 5000),
  });
  Object.defineProperty(doc.documentElement, "scrollHeight", {
    configurable: true,
    value: 5000,
  });
  [...doc.querySelectorAll("ins.redline, del.redline")].forEach((el, index) => {
    Object.defineProperty(el, "getBoundingClientRect", {
      configurable: true,
      value: fakeRect(markers[index].top, markers[index].height),
    });
  });
  return { container, frame, doc };
}

const twoBlocks = [
  { kind: "ins" as MarkerKind, top: 0, height: 20 },
  { kind: "del" as MarkerKind, top: 900, height: 20 },
];

const countText = () =>
  document.querySelector(".redline-nav-count")?.textContent;
const marked = (doc: Document) =>
  [...doc.querySelectorAll("[data-redline-current]")].map(
    (el) => el.textContent,
  );

/** Every controller must be disposed: each one adds a keydown listener to the SHELL window. */
const installed: MinimapController[] = [];
function install(
  container: HTMLElement,
  frame: HTMLIFrameElement,
  options = {},
): MinimapController {
  const controller = installMinimap(container, frame, options);
  installed.push(controller);
  return controller;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  installed.splice(0).forEach((controller) => controller.dispose());
});

describe("clusterMarkers", () => {
  it("returns no blocks for no markers", () => {
    expect(clusterMarkers([])).toEqual([]);
  });

  it("merges markers within the gap into one block", () => {
    const blocks = clusterMarkers([ins(0), ins(100), ins(250)]); // gaps of 80 and 130 ≤ 200
    expect(blocks).toEqual([block(0, 270, "ins")]);
  });

  it("starts a new block when the gap exceeds the threshold", () => {
    const blocks = clusterMarkers([ins(0), ins(500)]); // gap of 480 > 200
    expect(blocks).toEqual([block(0, 20, "ins"), block(500, 520, "ins")]);
  });

  it("measures the gap from the block's bottom, not its start", () => {
    // A tall marker: the next one is 350 below its TOP but only 50 below its BOTTOM.
    const blocks = clusterMarkers([ins(0, 300), ins(350)]);
    expect(blocks).toHaveLength(1);
  });

  it("skips zero-height markers (display:none content plots phantom blocks)", () => {
    const blocks = clusterMarkers([ins(0, 0), del(500)]);
    expect(blocks).toEqual([block(500, 520, "del")]);
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
    expect(blocks).toEqual([block(0, 400, "ins")]);
  });

  it("collects every element of a multi-marker block, not just the first", () => {
    // Two markers inside the gap: the branch that appends to an existing block. Without it the
    // current-block highlight would only ever mark one element of a block.
    const first = document.createElement("ins");
    const second = document.createElement("del");
    const blocks = clusterMarkers([
      { top: 0, height: 20, kind: "ins", el: first },
      { top: 100, height: 20, kind: "del", el: second },
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].elements).toEqual([first, second]);
  });

  it("carries each marker's element onto its block, through the filter and the sort", () => {
    // Without this there is nothing for the current-block highlight to mark.
    const first = document.createElement("ins");
    const second = document.createElement("del");
    const collapsed = document.createElement("ins");
    const blocks = clusterMarkers([
      { top: 600, height: 20, kind: "del", el: second },
      { top: 0, height: 0, kind: "ins", el: collapsed },
      { top: 0, height: 20, kind: "ins", el: first },
    ]);
    expect(blocks.map((b) => b.elements)).toEqual([[first], [second]]);
  });
});

describe("change counter", () => {
  it("shows the total with an en dash until a block is current, then the position", () => {
    const { container, frame } = withFakedLayout(twoBlocks);
    const controller = install(container, frame);

    expect(countText()).toBe("– / 2");
    controller.next();
    expect(countText()).toBe("1 / 2");
    controller.next();
    expect(countText()).toBe("2 / 2");
    controller.next(); // wraps
    expect(countText()).toBe("1 / 2");
    controller.prev();
    expect(countText()).toBe("2 / 2");
  });

  it("shows a zero total when nothing measures", () => {
    // No stubbed geometry: every marker is 0×0, exactly the collapsed-markers case.
    document.body.innerHTML =
      '<div id="app"><div class="redline-content"></div></div>';
    const container = document.querySelector<HTMLElement>(".redline-content")!;
    const frame = document.createElement("iframe");
    container.appendChild(frame);
    frame.contentDocument!.body.innerHTML =
      '<ins class="redline" data-diff-op="op-i" data-diff-node="insert">new</ins>';
    install(container, frame);
    expect(countText()).toBe("– / 0");
  });
});

describe("current-block highlight", () => {
  it("moves data-redline-current with navigation and clears it on dispose", () => {
    const { container, frame, doc } = withFakedLayout(twoBlocks);
    const controller = install(container, frame);

    expect(marked(doc)).toEqual([]);
    controller.next();
    expect(marked(doc)).toEqual(["new"]);
    controller.next();
    expect(marked(doc)).toEqual(["old"]); // the previous block's mark is removed, not added to

    controller.dispose();
    expect(marked(doc)).toEqual([]);
  });
});

describe("view modes", () => {
  it("stamps the mode on the framed document and presses the matching button", () => {
    const { container, frame, doc } = withFakedLayout(twoBlocks);
    const controller = install(container, frame);
    const pressed = () =>
      [...document.querySelectorAll(".redline-mode-button")]
        .filter((b) => b.getAttribute("aria-pressed") === "true")
        .map((b) => b.textContent);

    expect(doc.documentElement.dataset.redlineMode).toBe("redline");
    expect(pressed()).toEqual(["Redline"]);

    controller.setMode("original");
    expect(doc.documentElement.dataset.redlineMode).toBe("original");
    expect(pressed()).toEqual(["Original"]);

    controller.setMode("final");
    expect(doc.documentElement.dataset.redlineMode).toBe("final");
    expect(pressed()).toEqual(["Final"]);
  });

  it("warns in every mode when the side being shown has no geometry", () => {
    const onVisibility = vi.fn();
    // The reviewed document's CSS collapsed everything. Whichever side a mode shows, it is hidden.
    const { container, frame } = withFakedLayout([
      { kind: "ins", top: 0, height: 0 },
      { kind: "del", top: 900, height: 0 },
    ]);
    const controller = install(container, frame, { onVisibility });
    expect(onVisibility).toHaveBeenLastCalledWith(false);
    controller.setMode("final");
    expect(onVisibility).toHaveBeenLastCalledWith(false);
    controller.setMode("original");
    expect(onVisibility).toHaveBeenLastCalledWith(false);
  });

  it("warns only in the mode whose side is hidden, not in the one that can see its own", () => {
    // Insertions collapsed, deletions fine — what `html[data-redline-mode="final"] ins.redline
    // { display: none }` in a reviewed stylesheet produces. Final shows insertions, so Final is
    // the lie; Original shows deletions and is telling the truth.
    const onVisibility = vi.fn();
    const { container, frame } = withFakedLayout([
      { kind: "ins", top: 0, height: 0 },
      { kind: "del", top: 900, height: 20 },
    ]);
    const controller = install(container, frame, { onVisibility });

    controller.setMode("final");
    expect(onVisibility).toHaveBeenLastCalledWith(false);
    controller.setMode("original");
    expect(onVisibility).toHaveBeenLastCalledWith(true);
  });

  it("does not warn when the side a mode shows simply has nothing in it", () => {
    // An insertion-only diff has no deletions at all, so Original is empty by nature, not by
    // anyone hiding anything.
    const onVisibility = vi.fn();
    const { container, frame } = withFakedLayout([
      { kind: "ins", top: 0, height: 20 },
    ]);
    const controller = install(container, frame, { onVisibility });
    controller.setMode("original");
    expect(onVisibility).toHaveBeenLastCalledWith(true);
  });

  it("opens in the mode the shell remembered, and reports a change back to it", () => {
    // The controller is rebuilt on every render; the shell owns the reader's choice.
    const onMode = vi.fn();
    const { container, frame, doc } = withFakedLayout(twoBlocks);
    const controller = install(container, frame, { mode: "final", onMode });
    expect(doc.documentElement.dataset.redlineMode).toBe("final");
    expect(onMode).not.toHaveBeenCalled(); // opening in a mode is not the reader changing it

    controller.setMode("original");
    expect(onMode).toHaveBeenCalledWith("original");
  });

  it("the 1/2/3 keys switch mode", () => {
    const { container, frame, doc } = withFakedLayout(twoBlocks);
    install(container, frame);
    for (const [key, mode] of [
      ["1", "original"],
      ["3", "final"],
      ["2", "redline"],
    ] as const) {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true }),
      );
      expect(doc.documentElement.dataset.redlineMode).toBe(mode);
    }
  });

  it("re-derives the current block on a mode change rather than keeping a stale index", () => {
    // Three blocks; navigate to the second. Original hides the insertions, leaving one block —
    // the old index would name it while the reader sits at the top of the document.
    const { container, frame, doc } = withFakedLayout([
      { kind: "ins", top: 0, height: 20 },
      { kind: "ins", top: 900, height: 20 },
      { kind: "del", top: 1800, height: 20 },
    ]);
    const controller = install(container, frame);
    controller.next();
    controller.next();
    expect(countText()).toBe("2 / 3");

    // Hiding the insertions in happy-dom means dropping their stubbed geometry.
    for (const el of doc.querySelectorAll("ins.redline")) {
      Object.defineProperty(el, "getBoundingClientRect", {
        configurable: true,
        value: fakeRect(0, 0),
      });
    }
    controller.setMode("original");
    expect(countText()).toBe("1 / 1");
    // …and it names the block nearest where the reader actually is, not index 1 of the old list.
    expect(marked(doc)).toEqual(["old"]);
  });

  it("clamps the current block when a re-measure leaves fewer than there were", () => {
    const { container, frame, doc } = withFakedLayout(twoBlocks);
    const controller = install(container, frame);
    controller.next();
    controller.next();
    expect(countText()).toBe("2 / 2");

    // What a live refresh to a shorter document does: the ResizeObserver re-measures.
    doc.querySelector("del.redline")!.remove();
    controller.setMode("redline"); // any re-measure will do
    expect(countText()).toBe("1 / 1");
  });

  it("re-measures on a mode change, so the minimap follows the visible side", () => {
    const onState = vi.fn();
    const { container, frame } = withFakedLayout(twoBlocks);
    const controller = install(container, frame, { onState });
    onState.mockClear();
    // Hiding one side reflows without necessarily changing the document HEIGHT, so the
    // ResizeObserver cannot be relied on: setMode must measure itself.
    controller.setMode("original");
    expect(onState).toHaveBeenCalled();
  });
});
