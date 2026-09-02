// Vendored engine (MIT) with the atomic-tag boundary patch — see vendor/htmldiff.js header.
import htmldiff from "./vendor/htmldiff";
import type { EngineRequest, EngineResponse } from "./diff.worker";

/**
 * Atomic tags passed to node-htmldiff on EVERY call.
 *
 * The library default MUST NOT be used, even though the vendored engine patches the boundary bug
 * (see vendor/htmldiff.js): the default list contains `head`, which would treat the whole `<head>`
 * as one opaque token, and a stray `a`. This list is the default minus those two. Defense in
 * depth — the boundary patch kills the prefix-match failure class, this list keeps the semantics
 * we actually want.
 */
const ATOMIC_TAGS = "iframe,object,math,svg,script,video,style";

/**
 * Styling for the redline markers, injected into the merged document.
 *
 * Every declaration carries `!important` and the visibility-critical properties are pinned:
 * a reviewed stylesheet like `ins, del { display: none }` must not be able to hide real changes
 * while the viewer reports "marked changes". (`display` itself is not forced — a marker can wrap
 * block content, so no single value is right; markers hidden that way still have zero geometry
 * and are caught by the visibility check in the shell.)
 *
 * The marker text color is pinned dark on the markers themselves (not descendants): the
 * backgrounds are light, and a dark-themed reviewed document would otherwise inherit light text
 * into them — light-on-light. Elements inside a marker with their own color rules keep them.
 */
const REDLINE_CSS = `
  ins.redline, del.redline, [data-diff-node] {
    visibility: visible !important;
    opacity: 1 !important;
    content-visibility: visible !important;
  }
  ins.redline { background: #d3f2d3 !important; color: #1a1a1a !important; text-decoration: none !important; outline: 1px solid #7ac47a !important; }
  del.redline { background: #f8d7d7 !important; color: #1a1a1a !important; text-decoration: line-through !important; outline: 1px solid #d98c8c !important; }
  ins.redline img { outline: 3px solid #7ac47a !important; }
  del.redline img { outline: 3px solid #d98c8c !important; }
  /* Block elements the engine marks by annotating the tag itself (no ins/del wrapper) — see
     reconstructSide. Their text content is usually wrapped too; the dashed outline marks the
     structural change (and is the ONLY marking for annotation-only changes, e.g. empty blocks). */
  [data-diff-node="ins"] { outline: 1px dashed #7ac47a !important; }
  [data-diff-node="del"] { outline: 1px dashed #d98c8c !important; }
`;

/**
 * Content-Security-Policy for reviewed/redline documents: same-origin (the session's
 * `/doc/<session>/` routes) and data: assets only — a reviewed document must not be able to
 * phone home via images, stylesheets, or fonts. Scripts stay dead (sandbox + stripping + this).
 *
 * KEEP IN SYNC with `RedlineWebResources.DOC_CSP`, which serves the same policy as a response
 * header on the raw before/after session documents (used by the fallback states).
 */
export const DOC_CSP =
  "default-src 'self' data:; style-src 'self' 'unsafe-inline' data:; " +
  "script-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'";

export interface RedlineResult {
  /** The merged redline document. */
  html: string;
  /**
   * Number of change markers in the merged body: ins/del wrappers plus block elements the engine
   * annotates in place (`data-diff-node`) instead of wrapping — an added table row or list item
   * is an annotated element whose text is wrapped; an added empty block is annotation-only.
   */
  markerCount: number;
  /** The two heads differ; head changes are invisible by design (after head is kept). */
  headDiffers: boolean;
  /**
   * The merged body does not fully represent the before side — attribute-only changes the
   * engine silently resolves to the after markup. Detected by reconstructing the before side
   * from the redline (drop ins, unwrap del) and comparing with the real one.
   */
  bodyUnderReported: boolean;
  /**
   * The two sides differ only in whitespace or line endings that the renderer collapses away:
   * the sanitized head and body markup are identical once whitespace runs are collapsed, AND no
   * whitespace-preserving element changed at all. The rendered document is genuinely unchanged,
   * so the zero-marker state is not under-reporting anything — it is the truth, and the shell
   * says so with an info banner rather than a warning. (DOMParser has already normalised CRLF to
   * LF, so collapsing whitespace covers line-ending-only changes too.)
   */
  formattingOnly: boolean;
}

/** The engine is given this long to finish before the run is abandoned (see [runEngine]). */
export const DEFAULT_ENGINE_TIMEOUT_MS = 15_000;

/** The engine ran past its time budget and the run was abandoned. */
export class DiffTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`the redline engine did not finish within ${timeoutMs} ms`);
    this.name = "DiffTimeoutError";
  }
}

/** The caller aborted the run (the shell's Cancel button). */
export class DiffCancelledError extends Error {
  constructor() {
    super("the redline was cancelled");
    this.name = "DiffCancelledError";
  }
}

/** A started engine run: its eventual merged body, and the only way to stop it. */
export interface EngineRun {
  result: Promise<string>;
  terminate(): void;
}

export type EngineExecutor = (beforeBody: string, afterBody: string) => EngineRun;

export interface EngineOptions {
  /** Abandon the run after this long. Defaults to [DEFAULT_ENGINE_TIMEOUT_MS]. */
  timeoutMs?: number;
  /** Abort the run early (the shell's Cancel button). */
  signal?: AbortSignal;
  /** Test seam: run the engine some other way. Production always uses the default. */
  execute?: EngineExecutor;
}

/**
 * Run the engine on the main thread. Used where there is no `Worker` (happy-dom in the unit
 * tests) — the timeout cannot interrupt it there, since the engine never yields.
 */
function runInline(beforeBody: string, afterBody: string): EngineRun {
  return {
    result: Promise.resolve().then(() => htmldiff(beforeBody, afterBody, "redline", null, ATOMIC_TAGS)),
    terminate: () => {},
  };
}

function runInWorker(beforeBody: string, afterBody: string): EngineRun {
  // Vite emits the worker as its own chunk; `base: "./"` keeps the URL relative so it loads under
  // http://redline.localhost/ (and from the Playwright dist route in e2e/sandbox.spec.ts).
  const worker = new Worker(new URL("./diff.worker.ts", import.meta.url), { type: "module" });
  const result = new Promise<string>((resolve, reject) => {
    worker.addEventListener("message", (event: MessageEvent<EngineResponse>) => {
      worker.terminate();
      if ("error" in event.data) reject(new Error(event.data.error));
      else resolve(event.data.html);
    });
    worker.addEventListener("error", (event) => {
      worker.terminate();
      reject(new Error(event.message || "the redline worker failed"));
    });
    const request: EngineRequest = {
      before: beforeBody,
      after: afterBody,
      className: "redline",
      atomicTags: ATOMIC_TAGS,
    };
    worker.postMessage(request);
  });
  return { result, terminate: () => worker.terminate() };
}

const defaultExecutor: EngineExecutor = (beforeBody, afterBody) => {
  if (typeof Worker === "undefined") return runInline(beforeBody, afterBody);
  try {
    return runInWorker(beforeBody, afterBody);
  } catch {
    // A worker that cannot even be constructed (blocked, or a stripped-down runtime) must not
    // cost the redline: fall back to the main thread and let the time budget do its job.
    return runInline(beforeBody, afterBody);
  }
};

/**
 * The engine step, with a time budget and a cancel path.
 *
 * `htmldiff` is quadratic in token count, so a big document can run for minutes; on the main
 * thread that is an unresponsive pane with no way out. Terminating the worker is the only way to
 * stop a run in progress, which is why timeout and cancel both go through [EngineRun.terminate].
 */
export function runEngine(
  beforeBody: string,
  afterBody: string,
  options: EngineOptions = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_ENGINE_TIMEOUT_MS;
  const signal = options.signal;
  const run = (options.execute ?? defaultExecutor)(beforeBody, afterBody);

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      action();
    };
    const onAbort = (): void => {
      run.terminate();
      settle(() => reject(new DiffCancelledError()));
    };
    const timer = setTimeout(() => {
      run.terminate();
      settle(() => reject(new DiffTimeoutError(timeoutMs)));
    }, timeoutMs);

    run.result.then(
      (html) => settle(() => resolve(html)),
      (error) => settle(() => reject(error)),
    );

    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort);
  });
}

interface PreparedSides {
  before: Document;
  after: Document;
  beforeBody: string;
  afterBody: string;
  headDiffers: boolean;
  formattingOnly: boolean;
}

/** Parse and sanitize both sides. Stays on the main thread: workers have no DOMParser. */
function prepareSides(beforeHtml: string, afterHtml: string): PreparedSides {
  const parser = new DOMParser();
  const before = parser.parseFromString(beforeHtml, "text/html");
  const after = parser.parseFromString(afterHtml, "text/html");
  sanitizeReviewedDocument(before);
  sanitizeReviewedDocument(after);

  const beforeBody = before.body.innerHTML;
  const afterBody = after.body.innerHTML;
  return {
    before,
    after,
    beforeBody,
    afterBody,
    headDiffers: before.head.innerHTML !== after.head.innerHTML,
    formattingOnly:
      collapseWhitespace(before.head.innerHTML) === collapseWhitespace(after.head.innerHTML) &&
      collapseWhitespace(beforeBody) === collapseWhitespace(afterBody) &&
      preformattedMarkup(before) === preformattedMarkup(after),
  };
}

/** Everything after the engine call: the merged document plus its truthfulness signals. */
function assembleRedline(sides: PreparedSides, redlineBody: string, baseHref?: string): RedlineResult {
  const { before, after, beforeBody, headDiffers, formattingOnly } = sides;

  after.body.innerHTML = redlineBody;
  const markerCount = after.body.querySelectorAll("ins.redline, del.redline, [data-diff-node]").length;
  const bodyUnderReported =
    normalizeForComparison(reconstructSide(after.body, "before"), before) !==
    normalizeForComparison(beforeBody, before);

  // Head additions, in order: CSP first (governs everything after it), then base, then our CSS.
  const csp = after.createElement("meta");
  csp.setAttribute("http-equiv", "Content-Security-Policy");
  csp.setAttribute("content", DOC_CSP);
  after.head.insertBefore(csp, after.head.firstChild);
  if (baseHref) {
    const base = after.createElement("base");
    base.href = baseHref;
    after.head.insertBefore(base, csp.nextSibling);
  }
  const style = after.createElement("style");
  style.textContent = REDLINE_CSS;
  after.head.appendChild(style);

  return {
    html: `<!doctype html>\n${after.documentElement.outerHTML}`,
    markerCount,
    headDiffers,
    bodyUnderReported,
    formattingOnly,
  };
}

/**
 * Produce a single redline document from two full HTML documents: the after side's `<head>`
 * (styles resolve via the session's asset routes) with a merged body in which insertions and
 * deletions are wrapped in `<ins class="redline">` / `<del class="redline">`.
 *
 * The result carries truthfulness signals the viewer must surface: the engine cannot represent
 * head changes or attribute-only changes in the merged body, and those can coexist with marked
 * changes — zero markers is NOT the only under-reporting case.
 *
 * Asynchronous because the engine step runs in a worker: it is the one part that can leave the
 * main thread, and it is the part that can take minutes. It rejects with [DiffTimeoutError] or
 * [DiffCancelledError] if the run is abandoned — both mean "no redline", not "no changes", and
 * the shell must say so.
 *
 * @param baseHref When given, injected as `<base href>` in `<head>` so the document's relative
 *   asset URLs resolve against the session's `/doc/<session>/` routes rather than the shell page.
 *
 * Scripts and refresh directives are stripped as defense-in-depth; the structural guarantees are
 * the shell's sandboxed iframe (no `allow-scripts`) plus the injected CSP and the Kotlin-side
 * navigation guard.
 */
export async function buildRedline(
  beforeHtml: string,
  afterHtml: string,
  baseHref?: string,
  options: EngineOptions = {},
): Promise<RedlineResult> {
  const sides = prepareSides(beforeHtml, afterHtml);
  const redlineBody = await runEngine(sides.beforeBody, sides.afterBody, options);
  return assembleRedline(sides, redlineBody, baseHref);
}

/** Whitespace runs are invisible when rendered; collapse them before comparing two markups. */
function collapseWhitespace(html: string): string {
  return html.replace(/\s+/g, " ").trim();
}

/**
 * Elements that render their whitespace verbatim — inside them a reindent is a REAL, visible
 * change, so [collapseWhitespace] must not be allowed to declare it invisible. Compared exactly.
 *
 * Residual risk, accepted: whitespace preservation applied by a stylesheet rule (`p { white-space:
 * pre }`) is invisible to this check — only the elements that preserve whitespace by default and
 * inline `style` attributes mentioning `white-space` are caught. The cost of a miss is an info
 * banner where a warning was due, on a document that also produced zero markers.
 */
const PREFORMATTED_SELECTOR = "pre, textarea, xmp, listing, plaintext, [style*='white-space']";

function preformattedMarkup(doc: Document): string {
  return [...doc.body.querySelectorAll(PREFORMATTED_SELECTOR)].map((el) => el.outerHTML).join("\u0000");
}

/** Back-compat/test convenience: just the merged document. */
export async function diffHtml(beforeHtml: string, afterHtml: string, baseHref?: string): Promise<string> {
  return (await buildRedline(beforeHtml, afterHtml, baseHref)).html;
}

/**
 * Rebuild one side's body markup from the merged redline: the before side is everything except
 * insertions (drop `ins`, unwrap `del`); the after side is the mirror image. If the rebuilt
 * before side differs from the real one, the redline under-reports (attribute-only changes,
 * or structural changes the engine failed to mark at all, e.g. an added `<hr>`).
 *
 * The engine emits changes in TWO shapes, both handled here: inline content is wrapped in
 * `<ins>`/`<del>` elements, but block elements are ANNOTATED in place (`data-diff-node="ins|del"`
 * + `data-operation-index`, no wrapper) — an added `<li>` is an annotated li whose text carries
 * the wrapper. Annotations of the dropped side are removed with their element; annotations of the
 * kept side revert to the plain tag by stripping the marker attributes.
 */
function reconstructSide(mergedBody: Element, side: "before" | "after"): string {
  const [dropped, kept] = side === "before" ? (["ins", "del"] as const) : (["del", "ins"] as const);
  const clone = mergedBody.cloneNode(true) as Element;
  clone.querySelectorAll(`${dropped}.redline, [data-diff-node="${dropped}"]`).forEach((node) => node.remove());
  clone.querySelectorAll(`${kept}.redline`).forEach((node) => node.replaceWith(...node.childNodes));
  clone.querySelectorAll(`[data-diff-node="${kept}"]`).forEach((node) => {
    node.removeAttribute("data-diff-node");
    node.removeAttribute("data-operation-index");
  });
  return clone.innerHTML;
}

/**
 * Canonicalize markup for the under-reporting comparison. Two artifact classes of the token diff
 * must not masquerade as hidden changes:
 *
 * - Whitespace runs — tokenization may rearrange them, and they are invisible when rendered.
 * - Phantom EMPTY elements — a tag-alignment shift can match an added element's tags as "equal"
 *   and wrap only its text (`<li><ins>b</ins></li>`), leaving an attribute-less, content-less
 *   element behind in the reconstruction. Elements like that carry no reviewable information, so
 *   they are dropped from BOTH sides. (Cost: a bare void-element insertion such as `<hr>` is not
 *   flagged — it still renders in the redline, just unhighlighted, and an hr-only change still
 *   surfaces via the zero-marker "unrepresentable" state.)
 */
function normalizeForComparison(html: string, scratch: Document): string {
  const container = scratch.createElement("div");
  container.innerHTML = html;
  const elements = [...container.querySelectorAll("*")];
  // Reverse document order visits descendants before ancestors, so removals cascade upward
  // (emptying a <li> can empty its <ul>).
  for (let i = elements.length - 1; i >= 0; i--) {
    const el = elements[i];
    if (el.attributes.length === 0 && el.children.length === 0 && (el.textContent ?? "").trim() === "") {
      el.remove();
    }
  }
  return container.innerHTML.replace(/\s+/g, " ").trim();
}

/**
 * Defense-in-depth sanitization of a reviewed document (the structural guarantee is the sandbox):
 * script elements, inline event handlers, and refresh/redirect directives. A sandboxed frame
 * without `allow-scripts` still honors `<meta http-equiv="refresh">` — self-navigation is never
 * blocked by sandboxing — so refresh removal here (plus the Kotlin navigation guard) is what
 * actually keeps the pane on the redline.
 */
export function sanitizeReviewedDocument(doc: Document): void {
  doc.querySelectorAll("script").forEach((node) => node.remove());
  doc.querySelectorAll("meta[http-equiv]").forEach((node) => {
    if (node.getAttribute("http-equiv")?.trim().toLowerCase() === "refresh") node.remove();
  });
  // Inline handlers (onclick etc.) survive tag stripping; drop them too.
  doc.querySelectorAll("*").forEach((el) => {
    for (const attr of [...el.attributes]) {
      if (attr.name.toLowerCase().startsWith("on")) el.removeAttribute(attr.name);
    }
  });
  // The engine's tokenizer silently drops HTML comments; strip them from both sides up front so
  // a comment difference (invisible when rendered anyway) can't skew the under-reporting check.
  stripComments(doc);
}

function stripComments(node: Node): void {
  for (const child of [...node.childNodes]) {
    if (child.nodeType === Node.COMMENT_NODE) child.remove();
    else stripComments(child);
  }
}
