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
  /** The marked element, so the current block can be highlighted in the document itself. */
  el?: Element;
}

export interface ChangeBlock {
  top: number;
  bottom: number;
  kind: MarkerKind | "mixed";
  /** The marked elements this block was clustered from, in the order they were measured. */
  elements: Element[];
}

/**
 * What the frame shows. `redline` is the merged document with both sides marked; `original` hides
 * insertions and unstyles deletions; `final` hides deletions and unstyles insertions. The shell
 * stamps the choice on the framed document's root as `data-redline-mode` and the injected
 * REDLINE_CSS does the rest (see diff.ts).
 */
export type ViewMode = "original" | "redline" | "final";

const MODES: { mode: ViewMode; label: string; key: string }[] = [
  { mode: "original", label: "Original", key: "1" },
  { mode: "redline", label: "Redline", key: "2" },
  { mode: "final", label: "Final", key: "3" },
];

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

  const blocks: { top: number; bottom: number; kinds: Set<MarkerKind>; elements: Element[] }[] = [];
  for (const marker of visible) {
    const last = blocks[blocks.length - 1];
    if (last && marker.top - last.bottom <= gap) {
      last.bottom = Math.max(last.bottom, marker.top + marker.height);
      last.kinds.add(marker.kind);
      if (marker.el) last.elements.push(marker.el);
    } else {
      blocks.push({
        top: marker.top,
        bottom: marker.top + marker.height,
        kinds: new Set([marker.kind]),
        elements: marker.el ? [marker.el] : [],
      });
    }
  }

  return blocks.map(({ top, bottom, kinds, elements }) => ({
    top,
    bottom,
    kind: kinds.size > 1 ? "mixed" : [...kinds][0],
    elements,
  }));
}

/**
 * Measure every redline marker in the frame's document, in document coordinates. Markers come in
 * two shapes (see diff.ts#reconstructSide): ins/del wrappers for inline content, and block
 * elements annotated in place with `data-diff-node="ins|del"` (added/removed rows, list items).
 */
function measureMarkers(doc: Document): MarkerRect[] {
  // documentElement's rect.top is -scrollY, so subtracting it converts viewport to document
  // coordinates without touching the frame's scroll state.
  const docTop = doc.documentElement.getBoundingClientRect().top;
  return [...doc.querySelectorAll("ins.redline, del.redline, [data-diff-node]")].map((el) => {
    const annotated = el.getAttribute("data-diff-node");
    const rect = el.getBoundingClientRect();
    return {
      top: rect.top - docTop,
      height: rect.height,
      kind: (annotated ?? (el.tagName === "INS" ? "ins" : "del")) === "ins" ? "ins" : ("del" as MarkerKind),
      el,
    };
  });
}

/** Programmatic navigation over change blocks — same traversal the in-page buttons use. */
export interface MinimapController {
  next(): void;
  prev(): void;
  /**
   * Switch what the frame shows. Owns the framed document's `data-redline-mode` attribute, the
   * segmented control's pressed state, the re-measure a mode change needs, and the gate on the
   * "your styles hide the changes" signal — in `original`/`final` half the markers are hidden on
   * purpose, so that warning would be a lie there.
   */
  setMode(mode: ViewMode): void;
  /**
   * Remove the strip, the nav buttons and every listener. The shell calls this before it
   * re-renders (live refresh, side swap): the `keydown` listener sits on the SHELL window and
   * outlives the frame, so without this each re-render would leave another controller behind,
   * still scrolling a detached document on every `n`/`p`.
   */
  dispose(): void;
}

const NOOP_CONTROLLER: MinimapController = { next() {}, prev() {}, setMode() {}, dispose() {} };

/**
 * Install the minimap and navigation into `container` (which wraps `frame`). Call once the
 * redline document has been written into the frame; re-measurement on layout changes (late CSS,
 * images, pane resizes) is handled internally via a ResizeObserver.
 *
 * @returns A controller the shell exposes to the IDE toolbar (`window.__redlineNav`).
 */
export interface MinimapOptions {
  /**
   * Invoked on every (re-)measurement with whether the shell should treat the markers as visible
   * — see [markersVisible] for what that means per mode. The reviewed document's own CSS can
   * collapse markers to 0×0 (`ins, del { display:none }`) and the shell warns rather than
   * presenting an apparently unchanged page. Late stylesheet loads re-trigger measurement, so the
   * signal can flip in both directions and a warning already shown gets retracted.
   */
  onVisibility?: (anyMarkerVisible: boolean) => void;
  /**
   * Invoked whenever the block count or the current block changes (measurement, navigation,
   * manual scroll). The shell forwards this to the IDE toolbar over the JCEF bridge so the
   * toolbar next/prev actions can enable/disable.
   */
  onState?: (blockCount: number, current: number) => void;
  /**
   * Mode to open in. The shell remembers the reader's choice across re-renders and passes it back
   * — the controller is destroyed and rebuilt on every live refresh, so without this a keystroke
   * in the editor would snap the view back to Redline 400 ms later.
   */
  mode?: ViewMode;
  /** The reader changed mode; the shell stores it for the next render. */
  onMode?: (mode: ViewMode) => void;
}

export function installMinimap(
  container: HTMLElement,
  frame: HTMLIFrameElement,
  options: MinimapOptions = {},
): MinimapController {
  const { onVisibility, onState, onMode } = options;
  const win = frame.contentWindow;
  const doc = frame.contentDocument;
  if (!win || !doc) return NOOP_CONTROLLER;

  const strip = document.createElement("div");
  strip.className = "redline-minimap";

  const nav = document.createElement("div");
  nav.className = "redline-nav";
  const modes = document.createElement("div");
  modes.className = "redline-modes";
  modes.setAttribute("role", "group");
  modes.setAttribute("aria-label", "View mode");
  const modeButtons = MODES.map(({ mode, label, key }) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "redline-mode-button";
    button.textContent = label;
    button.title = `${label} (${key})`;
    button.addEventListener("click", () => setMode(mode));
    modes.appendChild(button);
    return button;
  });
  const prev = navButton("▲", "Previous change (p)");
  const count = document.createElement("span");
  count.className = "redline-nav-count";
  const next = navButton("▼", "Next change (n)");
  nav.append(modes, prev, count, next);

  container.append(strip, nav);

  let blocks: ChangeBlock[] = [];
  let current = -1;
  let mode: ViewMode = options.mode ?? "redline";
  let highlighted: Element[] = [];
  let disposed = false;

  function measure(): void {
    const markers = measureMarkers(doc!);
    blocks = clusterMarkers(markers);
    if (current >= blocks.length) current = blocks.length - 1;
    plot();
    // The signal is only meaningful once the document itself has layout — a zero-height document
    // (not laid out yet, or a layout-less test DOM) would falsely read as "all markers hidden".
    const hasLayout = doc!.documentElement.getBoundingClientRect().height > 0;
    if (markers.length > 0 && hasLayout) onVisibility?.(markersVisible(markers));
  }

  /**
   * Should the shell treat the markers as visible? The answer is per mode, because what SHOULD be
   * measurable is: in `redline`, every marker; in `original`/`final`, only the side that survives
   * — we hid the other one ourselves.
   *
   * Reporting a flat `true` outside redline mode is the tempting shortcut and it is a hole. It
   * hands a reviewed stylesheet a way to hide real changes with no warning at all, which is what
   * PLAN.md decision #6 exists to prevent — and the stylesheet can select on the very attribute
   * we set (`html[data-redline-mode="final"] ins.redline { display: none }`), so Redline can look
   * perfectly honest while Final is empty. The `display` hiding is invisible to the CSS pins in
   * diff.ts; measuring geometry is the only thing that catches it.
   */
  function markersVisible(markers: MarkerRect[]): boolean {
    const survivor = mode === "original" ? "del" : mode === "final" ? "ins" : null;
    const shown = survivor === null ? markers : markers.filter((m) => m.kind === survivor);
    // Nothing of the surviving side to show is not a failure: an insertion-only diff genuinely
    // has nothing marked in Original.
    return shown.length === 0 || shown.some((m) => m.height > 0);
  }

  function setMode(next: ViewMode): void {
    const changed = mode !== next;
    mode = next;
    doc!.documentElement.dataset.redlineMode = next;
    for (const [index, button] of modeButtons.entries()) {
      button.setAttribute("aria-pressed", String(MODES[index].mode === next));
    }
    // Hiding one side reflows the document, but not necessarily to a different HEIGHT — the
    // ResizeObserver cannot be relied on to notice, and every marker's position has moved.
    measure();
    // The old index names a different block now, and the reader has not moved. Re-derive from
    // where they are actually looking instead of claiming a position they are not at.
    if (current >= 0) {
      current = nearestBlock();
      plot();
    }
    if (changed) onMode?.(next);
  }

  /**
   * Mark the current block's elements in the document itself; the minimap tick alone is easy to
   * lose on a long page. Tracked rather than re-queried: `plot()` runs on every scroll frame.
   */
  function highlight(): void {
    for (const el of highlighted) el.removeAttribute("data-redline-current");
    highlighted = current >= 0 ? (blocks[current]?.elements ?? []) : [];
    for (const el of highlighted) el.setAttribute("data-redline-current", "");
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
    // "3 / 12"; an en dash where there is no current block, so the total still reads.
    count.textContent = `${current >= 0 ? current + 1 : "–"} / ${blocks.length}`;
    highlight();
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
    // These are bare letters and digits: they must not fire while the reader is typing a query
    // into the find bar, which is shell chrome and so shares this window's key events.
    if (isTypingTarget(event.target)) return;
    if (event.key === "n") goTo(current + 1);
    if (event.key === "p") goTo(current - 1);
    const chosen = MODES.find((m) => m.key === event.key);
    if (chosen) setMode(chosen.mode);
  };
  // Focus can sit in the shell or (after a click) in the frame's document; listen on both. The
  // handlers run in the shell's realm — the sandbox only kills the framed document's OWN scripts.
  window.addEventListener("keydown", onKey);
  doc.addEventListener("keydown", onKey);

  /** The block nearest the reading line (~1/3 down the viewport); -1 when there are none. */
  function nearestBlock(): number {
    if (blocks.length === 0) return -1;
    const line = win!.scrollY + win!.innerHeight / 3;
    let nearest = 0;
    for (let i = 1; i < blocks.length; i++) {
      if (Math.abs(blocks[i].top - line) < Math.abs(blocks[nearest].top - line)) nearest = i;
    }
    return nearest;
  }

  // Track the block nearest the reading line while scrolling manually.
  let scrollScheduled = false;
  const onScroll = (): void => {
    if (scrollScheduled || blocks.length === 0) return;
    scrollScheduled = true;
    requestAnimationFrame(() => {
      scrollScheduled = false;
      // Removing the listener does not cancel a frame already queued: reporting here after a
      // re-render disposed us would hand the IDE toolbar the OLD document's block count, and it
      // would enable Prev/Next with no `__redlineNav` behind them.
      if (disposed) return;
      const nearest = nearestBlock();
      if (nearest !== current) {
        current = nearest;
        plot();
      }
    });
  };
  win.addEventListener("scroll", onScroll);

  // Late-loading CSS/images and pane resizes reflow the document; re-measure when its size
  // settles rather than guessing with timers.
  const resizes = new ResizeObserver(() => measure());
  resizes.observe(doc.documentElement);
  setMode(mode);

  return {
    next: () => goTo(current + 1),
    prev: () => goTo(current - 1),
    setMode,
    dispose: () => {
      disposed = true;
      resizes.disconnect();
      window.removeEventListener("keydown", onKey);
      doc!.removeEventListener("keydown", onKey);
      win!.removeEventListener("scroll", onScroll);
      strip.remove();
      nav.remove();
      // The frame goes with the render, but leaving the attribute behind on a document the caller
      // might keep using would strand a highlight nothing owns any more.
      for (const el of highlighted) el.removeAttribute("data-redline-current");
      highlighted = [];
    },
  };
}

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== "function") return false;
  return el.closest("input, textarea, select, [contenteditable]") !== null;
}

function navButton(label: string, title: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "redline-nav-button";
  button.textContent = label;
  button.title = title;
  return button;
}
