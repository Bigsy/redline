import { buildRedline } from "./diff";
import { installMinimap } from "./minimap";

/**
 * Contract with the Kotlin side (RedlineDiffViewer), all optional so the shell runs standalone:
 * - `__redlineNav` is set by the shell when change navigation exists; the IDE toolbar's
 *   next/prev actions invoke it via `executeJavaScript`.
 * - `__redlineReport` is injected by Kotlin (a JBCefJSQuery call) after the page loads; the
 *   shell calls it with `"<blockCount>,<currentIndex>"` whenever navigation state changes.
 * - `__redlineFlush` is set by the shell and re-sends the latest state — Kotlin calls it right
 *   after injecting `__redlineReport`, closing the race where the shell reported before the
 *   bridge existed.
 */
declare global {
  interface Window {
    __redlineNav?: (direction: "next" | "prev") => void;
    __redlineReport?: (state: string) => void;
    __redlineFlush?: () => void;
  }
}

let lastNavState = "0,-1";

function reportNavState(blockCount: number, current: number): void {
  lastNavState = `${blockCount},${current}`;
  window.__redlineReport?.(lastNavState);
}

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
 *   4. fetch/diff failure       -> after side + warning banner (never a blank pane)
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

async function fetchSide(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`fetching ${url} failed: HTTP ${response.status}`);
  return response.text();
}

export async function bootSession(session: string): Promise<void> {
  // Absolute base: the redline is written into an about:blank frame, whose base URL is inherited
  // and murky — relative URLs must not depend on it.
  const docBase = new URL(`/doc/${encodeURIComponent(session)}/`, window.location.href).href;
  const afterUrl = `${docBase}after.html`;

  // The bridge may be injected before or after the shell finishes booting; __redlineFlush lets
  // the Kotlin side pull the latest state either way. States without navigation report "0,-1".
  lastNavState = "0,-1";
  window.__redlineFlush = () => window.__redlineReport?.(lastNavState);

  // The wrapper positions the minimap strip and nav buttons over the frame's right edge —
  // viewer chrome stays in the shell, outside the sandbox.
  const content = document.createElement("div");
  content.className = "redline-content";
  const frame = createFrame();
  content.appendChild(frame);
  app().appendChild(content);

  try {
    const [before, after] = await Promise.all([
      fetchSide(`${docBase}before.html`),
      fetchSide(afterUrl),
    ]);

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
      return;
    }

    if (before === after) {
      frame.src = afterUrl;
      showBanner("info", "No changes — both sides are identical.");
      return;
    }

    const redline = buildRedline(before, after, docBase);
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
      showBanner(
        "warning",
        "The files differ, but the change is not visible in rendered form " +
          "(e.g. attributes or <head> content) — showing the new version; use the text diff.",
      );
      return;
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
    const controller = installMinimap(
      content,
      frame,
      (anyMarkerVisible) => {
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
      reportNavState,
    );
    // The IDE toolbar's next/prev actions land here via executeJavaScript.
    window.__redlineNav = (direction) => (direction === "next" ? controller.next() : controller.prev());
  } catch (error) {
    frame.src = afterUrl;
    const message = error instanceof Error ? error.message : String(error);
    showBanner("warning", `Redline diff failed — showing the new version instead. (${message})`);
  }
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
  await bootSession(session);
}

export function renderFatal(error: unknown): void {
  // A visible error always beats a blank pane.
  const message = document.createElement("div");
  message.className = "redline-error";
  message.textContent = `Redline viewer failed to start: ${error instanceof Error ? error.message : String(error)}`;
  document.body.replaceChildren(message);
}
