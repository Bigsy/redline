/**
 * M3 — in-page overview ruler + change navigation.
 *
 * The JCEF pane can't use the IDE's editor gutter, so the shell draws its own minimap: a fixed
 * strip on the right edge with one tick per change block, plus next/prev controls. All of this
 * chrome lives in the shell page, OUTSIDE the sandboxed iframe — the reviewed document's CSS
 * can't touch it, and `allow-same-origin` lets the shell read `contentDocument` for measurement
 * and drive `contentWindow.scrollTo` (the frame's own scripts stay dead: no `allow-scripts`).
 */

export type MarkerKind = "ins" | "del";

/** A redline marker's box in document coordinates (top-relative to the document, not viewport). */
export interface MarkerRect {
  top: number;
  height: number;
  kind: MarkerKind;
}

export interface ChangeBlock {
  top: number;
  bottom: number;
  kind: MarkerKind | "mixed";
}

/** Vertical gap (px) between markers that starts a new change block. */
export const BLOCK_GAP = 200;

/**
 * Cluster markers into change blocks by vertical proximity.
 *
 * Zero-height markers are skipped: `display:none` content measures 0×0 and would plot phantom
 * blocks (typically at the top of the strip). Collapsed excerpt sections (M5) rely on the same
 * rule to drop out of the minimap.
 */
export function clusterMarkers(markers: MarkerRect[], gap: number = BLOCK_GAP): ChangeBlock[] {
  const visible = [...markers].filter((m) => m.height > 0).sort((a, b) => a.top - b.top);

  const blocks: { top: number; bottom: number; kinds: Set<MarkerKind> }[] = [];
  for (const marker of visible) {
    const last = blocks[blocks.length - 1];
    if (last && marker.top - last.bottom <= gap) {
      last.bottom = Math.max(last.bottom, marker.top + marker.height);
      last.kinds.add(marker.kind);
    } else {
      blocks.push({ top: marker.top, bottom: marker.top + marker.height, kinds: new Set([marker.kind]) });
    }
  }

  return blocks.map(({ top, bottom, kinds }) => ({
    top,
    bottom,
    kind: kinds.size > 1 ? "mixed" : [...kinds][0],
  }));
}

/** Measure every redline marker in the frame's document, in document coordinates. */
function measureMarkers(doc: Document): MarkerRect[] {
  // documentElement's rect.top is -scrollY, so subtracting it converts viewport to document
  // coordinates without touching the frame's scroll state.
  const docTop = doc.documentElement.getBoundingClientRect().top;
  return [...doc.querySelectorAll("ins.redline, del.redline")].map((el) => {
    const rect = el.getBoundingClientRect();
    return {
      top: rect.top - docTop,
      height: rect.height,
      kind: el.tagName === "INS" ? "ins" : ("del" as MarkerKind),
    };
  });
}

/** Programmatic navigation over change blocks — same traversal the in-page buttons use. */
export interface MinimapController {
  next(): void;
  prev(): void;
}

const NOOP_CONTROLLER: MinimapController = { next() {}, prev() {} };

/**
 * Install the minimap and navigation into `container` (which wraps `frame`). Call once the
 * redline document has been written into the frame; re-measurement on layout changes (late CSS,
 * images, pane resizes) is handled internally via a ResizeObserver.
 *
 * @param onVisibility Invoked on every (re-)measurement with whether ANY marker has geometry.
 *   The reviewed document's own CSS can collapse all markers to 0×0 (`ins, del { display:none }`)
 *   — the shell uses this to warn instead of presenting an apparently unchanged page. Late
 *   stylesheet loads re-trigger measurement, so the signal can flip in both directions.
 * @param onState Invoked whenever the block count or the current block changes (measurement,
 *   navigation, manual scroll). The shell forwards this to the IDE toolbar over the JCEF bridge
 *   so the toolbar next/prev actions can enable/disable.
 * @returns A controller the shell exposes to the IDE toolbar (`window.__redlineNav`).
 */
export function installMinimap(
  container: HTMLElement,
  frame: HTMLIFrameElement,
  onVisibility?: (anyMarkerVisible: boolean) => void,
  onState?: (blockCount: number, current: number) => void,
): MinimapController {
  const win = frame.contentWindow;
  const doc = frame.contentDocument;
  if (!win || !doc) return NOOP_CONTROLLER;

  const strip = document.createElement("div");
  strip.className = "redline-minimap";

  const nav = document.createElement("div");
  nav.className = "redline-nav";
  const prev = navButton("▲", "Previous change (p)");
  const next = navButton("▼", "Next change (n)");
  nav.append(prev, next);

  container.append(strip, nav);

  let blocks: ChangeBlock[] = [];
  let current = -1;

  function measure(): void {
    const markers = measureMarkers(doc!);
    blocks = clusterMarkers(markers);
    plot();
    // The signal is only meaningful once the document itself has layout — a zero-height document
    // (not laid out yet, or a layout-less test DOM) would falsely read as "all markers hidden".
    const hasLayout = doc!.documentElement.getBoundingClientRect().height > 0;
    if (markers.length > 0 && hasLayout) onVisibility?.(blocks.length > 0);
  }

  function plot(): void {
    const docHeight = Math.max(doc!.documentElement.scrollHeight, 1);
    strip.replaceChildren(
      ...blocks.map((block, index) => {
        const tick = document.createElement("div");
        tick.className = `redline-tick ${block.kind}${index === current ? " current" : ""}`;
        tick.style.top = `${(block.top / docHeight) * 100}%`;
        tick.style.height = `${Math.max(((block.bottom - block.top) / docHeight) * 100, 0.5)}%`;
        tick.title = `Change ${index + 1} of ${blocks.length}`;
        tick.addEventListener("click", () => goTo(index));
        return tick;
      }),
    );
    onState?.(blocks.length, current);
  }

  function goTo(index: number): void {
    if (blocks.length === 0) return;
    current = ((index % blocks.length) + blocks.length) % blocks.length;
    win!.scrollTo({
      top: Math.max(blocks[current].top - win!.innerHeight / 3, 0),
      behavior: "smooth",
    });
    plot();
  }

  prev.addEventListener("click", () => goTo(current - 1));
  next.addEventListener("click", () => goTo(current + 1));

  const onKey = (event: KeyboardEvent): void => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key === "n") goTo(current + 1);
    if (event.key === "p") goTo(current - 1);
  };
  // Focus can sit in the shell or (after a click) in the frame's document; listen on both. The
  // handlers run in the shell's realm — the sandbox only kills the framed document's OWN scripts.
  window.addEventListener("keydown", onKey);
  doc.addEventListener("keydown", onKey);

  // Track the block nearest the reading line (~1/3 down the viewport) while scrolling manually.
  let scrollScheduled = false;
  win.addEventListener("scroll", () => {
    if (scrollScheduled || blocks.length === 0) return;
    scrollScheduled = true;
    requestAnimationFrame(() => {
      scrollScheduled = false;
      const line = win!.scrollY + win!.innerHeight / 3;
      let nearest = 0;
      for (let i = 0; i < blocks.length; i++) {
        if (Math.abs(blocks[i].top - line) < Math.abs(blocks[nearest].top - line)) nearest = i;
      }
      if (nearest !== current) {
        current = nearest;
        plot();
      }
    });
  });

  // Late-loading CSS/images and pane resizes reflow the document; re-measure when its size
  // settles rather than guessing with timers.
  new ResizeObserver(() => measure()).observe(doc.documentElement);
  measure();

  return { next: () => goTo(current + 1), prev: () => goTo(current - 1) };
}

function navButton(label: string, title: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "redline-nav-button";
  button.textContent = label;
  button.title = title;
  return button;
}
