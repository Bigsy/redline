import {
  buildRedline,
  DEFAULT_ENGINE_TIMEOUT_MS,
  DiffCancelledError,
  DiffTimeoutError,
  type EngineOptions,
} from "./diff";
import { installFindBar, type FindBar } from "./findbar";
import { installMinimap, type MinimapController, type ViewMode } from "./minimap";

/**
 * Contract with the Kotlin side (RedlineDiffViewer), all optional so the shell runs standalone:
 * - `__redlineNav` is set by the shell when change navigation exists; the IDE toolbar's
 *   next/prev actions invoke it via `executeJavaScript`.
 * - `__redlineReport` is injected by Kotlin (a JBCefJSQuery call) after the page loads; the
 *   shell calls it with `"<blockCount>,<currentIndex>"` whenever navigation state changes.
 * - `__redlineFlush` is set by the shell and re-sends the latest state — Kotlin calls it right
 *   after injecting `__redlineReport`, closing the race where the shell reported before the
 *   bridge existed.
 * - `__redlineReload` is set by the shell and re-renders in place from the session URLs. Kotlin
 *   calls it after replacing the live session's content (the reviewed document was edited in the
 *   IDE, or Swap Sides was pressed) instead of reloading the page, which would lose the reader's
 *   scroll position and re-run the bridge-injection race.
 */
declare global {
  interface Window {
    __redlineNav?: (direction: "next" | "prev") => void;
    __redlineReport?: (state: string) => void;
    __redlineFlush?: () => void;
    __redlineReload?: () => void;
  }
}

/**
 * Documents bigger than this (both sides together, in characters) skip the engine entirely.
 *
 * The engine is quadratic in token count: measured on a synthetic repetitive pair, 65 KB diffs in
 * 1.2 s, 262 KB in 72 s, and 650 KB did not finish in 5 minutes. So this is a ceiling, not a
 * promise — the time budget below is what actually protects the pane; this only avoids making the
 * user wait 15 s to be told what was obvious from the size.
 */
const SIZE_LIMIT = 2_000_000;

/**
 * How long the engine may run before the "Computing redline…" banner appears. Most diffs finish
 * in milliseconds; showing the banner immediately would flash it on every single one.
 */
const COMPUTING_BANNER_DELAY_MS = 250;

let lastNavState = "0,-1";

function reportNavState(blockCount: number, current: number): void {
  lastNavState = `${blockCount},${current}`;
  window.__redlineReport?.(lastNavState);
}

// Per-session state, shared between the first render and every live re-render. `generation`
// invalidates a render that is still awaiting when the next one starts: its continuations must
// not write banners into the new render's DOM (see `render`).
let docBase = "";
let bootOptions: BootOptions = {};
let generation = 0;
let currentFrame: HTMLIFrameElement | null = null;
let minimap: MinimapController | null = null;
// Session-scoped, unlike the minimap: the bar lives on document.body so a re-render cannot
// replace it, and it keeps the reader's query across live refreshes.
let findBar: FindBar | null = null;
let engineRun: AbortController | null = null;

/**
 * Scroll offset a live reload wants restored, held here rather than read off the frame when the
 * restore happens: `render()` swaps `currentFrame` for a fresh frame at the top of the document
 * the instant it starts, so a reload arriving while the previous one is still fetching or diffing
 * would read 0 and quietly send the reader to the top — precisely the continuous-typing case on a
 * slow document that this batch exists for. Cleared only by the render that applies it.
 */
let pendingScrollTop: number | null = null;

/**
 * The reader's Original/Redline/Final choice. Session state, not render state: the minimap
 * controller that owns the mode is disposed and rebuilt by every render, so without this a
 * keystroke in the editor would snap the view back to Redline 400 ms later — undoing the "keep
 * your place" that batch C is for.
 */
let viewMode: ViewMode = "redline";

/**
 * Viewer shell logic — the only page ever loaded top-level in the JCEF pane. (Thin entry point
 * in main.ts; separated so the state machine is unit-testable.)
 *
 * Reviewed content renders inside `<iframe sandbox="allow-same-origin">` with NO `allow-scripts`:
 * the browser structurally guarantees the reviewed documents' own scripts never execute. What the
 * sandbox does NOT prevent is self-navigation (`<meta http-equiv="refresh">`) and subresource
 * network access — those are contained by sanitization + the injected CSP (diff.ts) and the
 * Kotlin-side JCEF navigation guard. `allow-same-origin` is safe without `allow-scripts` and
 * required: the shell must reach `contentDocument` to write the redline and measure change blocks.
 *
 * The viewer always states which truthfulness state it is showing:
 *   0. one-sided (added/deleted)-> the side that exists + info banner (nothing to merge)
 *   1. identical inputs         -> after side + "no changes" banner
 *   2. marked changes           -> redline document; if the head or attributes ALSO changed
 *                                  invisibly, a banner says the highlights are incomplete
 *   3. changed, unrepresentable -> after side + warning banner pointing at the text diff
 *                                  (or, for whitespace/line-ending-only edits, an info banner
 *                                  saying the rendered document is unchanged)
 *   4. fetch/diff failure       -> after side + warning banner (never a blank pane)
 *   5. too large / timed out /   -> after side + warning banner pointing at the text diff; the
 *      cancelled                    document is intact, only the redline was abandoned
 * Additionally, if the reviewed document's own CSS collapses every marker to zero geometry, a
 * warning appears rather than an apparently unchanged page.
 */

function app(): HTMLElement {
  const el = document.getElementById("app");
  if (!el) throw new Error("shell page has no #app element");
  return el;
}

function createFrame(): HTMLIFrameElement {
  const frame = document.createElement("iframe");
  frame.className = "redline-frame";
  // Set via attribute, not the `sandbox` DOMTokenList, so it is in force before anything loads.
  frame.setAttribute("sandbox", "allow-same-origin");
  return frame;
}

/** Banner above the frame stating which truthfulness state the viewer is in. */
function showBanner(kind: "info" | "warning", text: string): HTMLElement {
  const banner = document.createElement("div");
  banner.className = `redline-banner ${kind}`;
  banner.textContent = text;
  app().prepend(banner);
  return banner;
}

/**
 * The "no redline for this one" message, shared by the size pre-check and the time budget: both
 * mean the reviewed document is fine and only the comparison was abandoned.
 */
function tooLargeMessage(timeoutMs?: number): string {
  const gaveUp = timeoutMs === undefined ? "" : ` (gave up after ${Math.round(timeoutMs / 1000)} s)`;
  return (
    `This document is too large for the rendered redline${gaveUp} — ` +
    "showing the new version; use the text diff."
  );
}

/** Info banner shown while the engine runs, carrying the Cancel control. */
function showComputingBanner(onCancel: () => void): HTMLElement {
  const banner = showBanner("info", "Computing redline… ");
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "redline-cancel";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", onCancel);
  banner.appendChild(cancel);
  return banner;
}

async function fetchSide(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`fetching ${url} failed: HTTP ${response.status}`);
  return response.text();
}

/**
 * `timeoutMs` is the engine time budget, set from the viewer URL's `?diffTimeoutMs=` (the e2e
 * suite uses it to force the give-up state); `execute` is diff.ts's test seam, which [boot] never
 * sets — the unit tests need it to reach the timeout and cancel states, because the inline engine
 * they run against cannot be interrupted.
 */
export type BootOptions = Pick<EngineOptions, "timeoutMs" | "execute">;

export async function bootSession(session: string, options: BootOptions = {}): Promise<void> {
  // Absolute base: the redline is written into an about:blank frame, whose base URL is inherited
  // and murky — relative URLs must not depend on it.
  docBase = new URL(`/doc/${encodeURIComponent(session)}/`, window.location.href).href;
  bootOptions = options;

  // The bridge may be injected before or after the shell finishes booting; __redlineFlush lets
  // the Kotlin side pull the latest state either way. States without navigation report "0,-1".
  findBar ??= installFindBar();
  window.__redlineFlush = () => window.__redlineReport?.(lastNavState);
  // Kotlin calls this after pushing new document text into the live session; the URLs are
  // unchanged, so re-rendering means refetching and running the state machine again.
  window.__redlineReload = () => {
    void reload();
  };

  await render();
}

/**
 * Re-render in place after the reviewed documents changed under us.
 *
 * The scroll offset is the only thing carried over: the minimap re-derives which change block is
 * current from it (its scroll tracker fires on the restoring scroll), and the block that WAS
 * current may not exist any more anyway.
 */
async function reload(): Promise<void> {
  if (pendingScrollTop === null) pendingScrollTop = currentFrame?.contentWindow?.scrollY ?? 0;
  const frame = await render();
  // A later reload took over while this one was in flight; it owns the offset and the restore.
  if (frame !== currentFrame) return;
  const top = pendingScrollTop;
  pendingScrollTop = null;
  restoreScroll(frame, top);
}

/**
 * Put the reader back where they were, clamped — the edit may have made the document shorter than
 * the old offset.
 *
 * Applied twice, because the clamp needs a height it can trust. A written redline can be scrolled
 * the instant `document.close()` returns, but its `<link>` stylesheets have not applied yet
 * (measured in Chromium: 150 px immediately, 1848 px once the sheet landed) — clamping against
 * the unstyled height would drop the reader near the top of a styled document. The frame's `load`
 * fires with the settled height for both a written document's subresources and an `src`
 * navigation, so: once now, for documents with nothing to wait for, and again when it settles.
 */
function restoreScroll(frame: HTMLIFrameElement, top: number): void {
  if (top <= 0) return;
  const apply = (): void => {
    // A later render may own the pane by the time a slow stylesheet resolves.
    if (frame !== currentFrame) return;
    const win = frame.contentWindow;
    const root = frame.contentDocument?.documentElement;
    if (!win || !root) return;
    win.scrollTo(0, Math.min(top, Math.max(root.scrollHeight - root.clientHeight, 0)));
  };
  apply();
  frame.addEventListener("load", apply, { once: true });
}

/**
 * Fetch both sides and run the truthfulness state machine into a fresh frame. Returns that frame
 * so a live reload can restore the scroll offset once the state is settled.
 *
 * Everything the previous render left behind is torn down first — an engine run still in flight,
 * the minimap's listeners on the SHELL window, the banners, the `__redlineNav` hook — and the
 * nav state is reported as empty so the IDE toolbar disables until the new blocks are measured.
 */
async function render(): Promise<HTMLIFrameElement> {
  const mine = ++generation;
  /** True once a later render started: this one's awaits must stop writing to the shared DOM. */
  const superseded = (): boolean => generation !== mine;

  engineRun?.abort();
  minimap?.dispose();
  minimap = null;
  delete window.__redlineNav;
  app().replaceChildren();
  reportNavState(0, -1);

  // The wrapper positions the minimap strip and nav buttons over the frame's right edge —
  // viewer chrome stays in the shell, outside the sandbox.
  const content = document.createElement("div");
  content.className = "redline-content";
  const frame = createFrame();
  content.appendChild(frame);
  app().appendChild(content);
  currentFrame = frame;

  const afterUrl = `${docBase}after.html`;
  // Whatever state this render lands in, find has to work against the document it leaves in the
  // frame — including the fallback states, which never build a redline. The frame is navigated
  // by `src` in those, so wait for the load before searching it.
  const handOverToFind = (): void => {
    if (frame !== currentFrame) return;
    if (frame.getAttribute("src")) frame.addEventListener("load", () => findBar?.attach(frame), { once: true });
    else findBar?.attach(frame);
  };

  try {
    const [before, after] = await Promise.all([
      fetchSide(`${docBase}before.html`),
      fetchSide(afterUrl),
    ]);
    if (superseded()) return frame;

    // One-sided diff (file added or deleted): there is nothing to merge, and wrapping an entire
    // document in ins/del markup would be noise, not signal. Render the side that exists, plainly,
    // and say why. (Diffing against the empty side would also trip the headDiffers warning with a
    // misleading "highlights are incomplete" message.)
    const beforeEmpty = before.trim() === "";
    const afterEmpty = after.trim() === "";
    if (beforeEmpty !== afterEmpty) {
      if (beforeEmpty) {
        frame.src = afterUrl;
        showBanner("info", "This file was added — showing the new document (no earlier version to compare).");
      } else {
        frame.src = `${docBase}before.html`;
        showBanner("info", "This file was deleted — showing the removed document.");
      }
      return frame;
    }

    if (before === after) {
      frame.src = afterUrl;
      showBanner("info", "No changes — both sides are identical.");
      return frame;
    }

    const timeoutMs = bootOptions.timeoutMs ?? DEFAULT_ENGINE_TIMEOUT_MS;
    if (before.length + after.length > SIZE_LIMIT) {
      // Nothing is lost by not trying: the engine would run for minutes and then be abandoned.
      frame.src = afterUrl;
      showBanner("warning", tooLargeMessage());
      return frame;
    }

    // The engine runs in a worker, so the pane stays responsive — but the user still needs to
    // know why nothing has appeared yet, and to be able to give up.
    const cancellation = new AbortController();
    engineRun = cancellation;
    let removeComputingBanner = (): void => {};
    const computingTimer = setTimeout(() => {
      if (superseded()) return;
      const banner = showComputingBanner(() => cancellation.abort());
      removeComputingBanner = () => banner.remove();
    }, COMPUTING_BANNER_DELAY_MS);
    let redline;
    try {
      redline = await buildRedline(before, after, docBase, {
        timeoutMs,
        signal: cancellation.signal,
        execute: bootOptions.execute,
      });
    } catch (error) {
      // A superseded run was aborted BY the next render — that is not a state to report.
      if (superseded()) return frame;
      if (error instanceof DiffTimeoutError || error instanceof DiffCancelledError) {
        // The redline was abandoned, not the document: show the new version and say which.
        frame.src = afterUrl;
        showBanner(
          "warning",
          error instanceof DiffTimeoutError
            ? tooLargeMessage(error.timeoutMs)
            : "Redline cancelled — showing the new version; use the text diff.",
        );
        return frame;
      }
      throw error;
    } finally {
      clearTimeout(computingTimer);
      removeComputingBanner();
    }
    if (superseded()) return frame;

    const doc = frame.contentDocument;
    if (!doc) throw new Error("sandboxed frame document is not reachable");
    doc.open();
    doc.write(redline.html);
    doc.close();

    if (doc.querySelector("ins.redline, del.redline, [data-diff-node]") === null) {
      // The sides differ but the redline carries no markers — neither wrappers nor block-level
      // annotations: attribute-only or <head>-only changes (or an engine gap we haven't met).
      // Showing the unmarked merge would falsely read as "no changes" — show the plain after
      // side and say so.
      frame.src = afterUrl;
      if (redline.formattingOnly) {
        // Whitespace/CRLF-only edits: nothing is missing from the rendered view, so the warning
        // ("use the text diff") would send the reviewer looking for a change that isn't there.
        showBanner(
          "info",
          "Only whitespace or line endings differ — the rendered document is unchanged.",
        );
      } else {
        showBanner(
          "warning",
          "The files differ, but the change is not visible in rendered form " +
            "(e.g. attributes or <head> content) — showing the new version; use the text diff.",
        );
      }
      return frame;
    }

    if (redline.headDiffers || redline.bodyUnderReported) {
      // Markers exist, but they are not the whole story: attribute or <head> changes ride along
      // invisibly. Without this the viewer would silently under-report mixed changes.
      showBanner(
        "warning",
        "Some changes are not visible in rendered form (attributes or <head> content) — " +
          "the highlights below are incomplete; check the text diff for the rest.",
      );
    }

    let hiddenWarning: HTMLElement | null = null;
    const controller = installMinimap(content, frame, {
      mode: viewMode,
      onMode: (mode) => {
        viewMode = mode;
        // The mode just hid one side, so any match inside it is unreachable — the count must stop
        // offering it and navigation must stop landing on it. The minimap does not know the find
        // bar exists; this is where the two meet.
        findBar?.refresh();
      },
      onVisibility: (anyMarkerVisible: boolean) => {
        // The reviewed document's own CSS can collapse every marker to zero geometry (e.g.
        // `ins, del { display: none }`) — an apparently unchanged page. Say so; retract if a
        // late stylesheet load makes them visible again.
        if (!anyMarkerVisible && hiddenWarning === null) {
          hiddenWarning = showBanner(
            "warning",
            "This document's own styles hide the changed content — the highlights exist but are " +
              "not visible. Use the text diff.",
          );
        } else if (anyMarkerVisible && hiddenWarning !== null) {
          hiddenWarning.remove();
          hiddenWarning = null;
        }
      },
      onState: reportNavState,
    });
    minimap = controller;
    // The IDE toolbar's next/prev actions land here via executeJavaScript.
    window.__redlineNav = (direction) => (direction === "next" ? controller.next() : controller.prev());
  } catch (error) {
    if (superseded()) return frame;
    frame.src = afterUrl;
    const message = error instanceof Error ? error.message : String(error);
    showBanner("warning", `Redline diff failed — showing the new version instead. (${message})`);
  } finally {
    if (!superseded()) handOverToFind();
  }
  return frame;
}

/**
 * Theme the SHELL chrome (banners, minimap, nav buttons) to match the IDE. The reviewed document
 * itself always renders on a light canvas (`.redline-frame` pins `background: #fff`): an HTML
 * document's default canvas is white, so forcing it dark would misrender documents that assume
 * it — and it keeps the light marker colors readable regardless of IDE theme.
 */
export function applyTheme(theme: string | null): void {
  document.documentElement.dataset.theme = theme === "dark" ? "dark" : "light";
}

export async function boot(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  applyTheme(params.get("theme"));
  const session = params.get("session");
  if (!session) throw new Error("no session parameter in viewer URL");
  const timeoutMs = Number(params.get("diffTimeoutMs"));
  await bootSession(session, {
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : undefined,
  });
}

export function renderFatal(error: unknown): void {
  // A visible error always beats a blank pane.
  const message = document.createElement("div");
  message.className = "redline-error";
  message.textContent = `Redline viewer failed to start: ${error instanceof Error ? error.message : String(error)}`;
  document.body.replaceChildren(message);
}
