/** Whole sanitized bodies enter one bounded worker; the browser independently validates both projections. */
import type {
  EngineRequest,
  EngineResponse,
  EngineSuccess,
  MarkdownRequest,
  MarkdownResponse,
} from "./engine-protocol";
import {
  MARKER_SELECTOR,
  canonicalBody,
  projectBody,
  elements,
} from "./review-document";
const REDLINE_CSS = `
  [data-diff-op][data-diff-node], [data-diff-op][data-diff-unwrap], [data-diff-op][data-diff-attrs] {
    visibility: visible !important; opacity: 1 !important; content-visibility: visible !important;
  }
  [data-diff-node="insert"] { background: #d3f2d3 !important; color: #1a1a1a !important; text-decoration: none !important; outline: 1px solid #7ac47a !important; }
  [data-diff-node="delete"] { background: #f8d7d7 !important; color: #1a1a1a !important; text-decoration: line-through !important; outline: 1px solid #d98c8c !important; }
  [data-diff-unwrap] { outline: 1px dashed #b58a25 !important; }
  [data-diff-op][data-diff-attrs] { outline: 2px dashed #b58a25 !important; }
  [data-redline-current] { box-shadow: 0 0 0 2px #3574f0 !important; }
  ::highlight(redline-current) { background: #a8c7ff; }
`;

export const DOC_CSP =
  "default-src 'self' data:; style-src 'self' 'unsafe-inline' data:; " +
  "script-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'";

export interface RedlineResult {
  html: string;
  reducedPrecision: boolean;
  wholeCodeBlocksOnly: boolean;
  timings: EngineSuccess["timings"];
  markerCount: number;
  headDiffers: boolean;
  bodyUnderReported: boolean;
  formattingOnly: boolean;
}

export const DEFAULT_ENGINE_TIMEOUT_MS = 15_000;

export class DiffTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`the redline engine did not finish within ${timeoutMs} ms`);
    this.name = "DiffTimeoutError";
  }
}

export class DiffCancelledError extends Error {
  constructor() {
    super("the redline was cancelled");
    this.name = "DiffCancelledError";
  }
}

export class DiffEngineError extends Error {
  constructor(readonly response: EngineResponse) {
    super(
      response.outcome === "failure"
        ? response.message
        : response.outcome === "limit"
          ? `Engine limit: ${response.limit}`
          : "Unsupported engine representation",
    );
    this.name = "DiffEngineError";
  }
}

export interface EngineRun {
  result: Promise<EngineSuccess>;
  terminate(): void;
}

export type EngineExecutor = (
  beforeBody: string,
  afterBody: string,
) => EngineRun;

export interface EngineOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  execute?: EngineExecutor;
}

export interface MarkdownOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export class MarkdownError extends Error {
  constructor(readonly response: MarkdownResponse) {
    super(
      response.outcome === "limit"
        ? `Markdown ${response.limit} limit exceeded`
        : response.outcome === "failure"
          ? response.message
          : "Markdown conversion failed",
    );
    this.name = "MarkdownError";
  }
}

function runInWorker(beforeBody: string, afterBody: string): EngineRun {
  const worker = new Worker(new URL("./diff.worker.ts", import.meta.url), {
    type: "module",
  });
  const result = new Promise<EngineSuccess>((resolve, reject) => {
    worker.addEventListener(
      "message",
      (event: MessageEvent<EngineResponse>) => {
        const response = event.data;
        if (
          response.outcome === "success" &&
          (response.modelVersion === 1 || response.modelVersion === 2)
        )
          resolve(response);
        else reject(new DiffEngineError(response));
      },
    );
    worker.addEventListener("error", (event) =>
      reject(new Error(event.message || "Redline worker unavailable")),
    );
    worker.addEventListener("messageerror", () =>
      reject(new Error("Redline worker response unavailable")),
    );
    const request: EngineRequest = { kind: "engine", before: beforeBody, after: afterBody };
    try {
      worker.postMessage(request);
    } catch (error) {
      worker.terminate();
      reject(error);
    }
  });
  return { result, terminate: () => worker.terminate() };
}
const defaultExecutor: EngineExecutor = runInWorker;

interface MarkdownRun {
  result: Promise<string>;
  terminate(): void;
}

function runMarkdownWorker(source: string): MarkdownRun {
  const worker = new Worker(new URL("./diff.worker.ts", import.meta.url), {
    type: "module",
  });
  const result = new Promise<string>((resolve, reject) => {
    worker.addEventListener(
      "message",
      (event: MessageEvent<MarkdownResponse>) => {
        const response = event.data;
        if (response.kind !== "markdown") return;
        if (response.outcome === "success") resolve(response.html);
        else reject(new MarkdownError(response));
      },
    );
    worker.addEventListener("error", (event) =>
      reject(new Error(event.message || "Markdown worker unavailable")),
    );
    worker.addEventListener("messageerror", () =>
      reject(new Error("Markdown worker response unavailable")),
    );
    const request: MarkdownRequest = { kind: "markdown", source };
    try {
      worker.postMessage(request);
    } catch (error) {
      worker.terminate();
      reject(error);
    }
  });
  return { result, terminate: () => worker.terminate() };
}

/** Parse Markdown in a worker. The worker is always terminated when this settles. */
export function prepareMarkdown(
  source: string,
  options: MarkdownOptions = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_ENGINE_TIMEOUT_MS;
  if (options.signal?.aborted) return Promise.reject(new DiffCancelledError());
  let run: MarkdownRun;
  try {
    run = runMarkdownWorker(source);
  } catch (error) {
    return Promise.reject(new Error(`Markdown worker unavailable: ${String(error)}`));
  }
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      run.terminate();
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      action();
    };
    const onAbort = (): void => settle(() => reject(new DiffCancelledError()));
    const timer = setTimeout(() =>
      settle(() => reject(new DiffTimeoutError(timeoutMs))), timeoutMs);
    run.result.then(
      (html) => settle(() => resolve(html)),
      (error) => settle(() => reject(error)),
    );
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort);
  });
}

export function runEngine(
  beforeBody: string,
  afterBody: string,
  options: EngineOptions = {},
): Promise<EngineSuccess> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_ENGINE_TIMEOUT_MS;
  const signal = options.signal;
  if (signal?.aborted) return Promise.reject(new DiffCancelledError());
  let run: EngineRun;
  try {
    run = (options.execute ?? defaultExecutor)(beforeBody, afterBody);
  } catch (error) {
    return Promise.reject(
      new Error(`Redline worker unavailable: ${String(error)}`),
    );
  }

  return new Promise<EngineSuccess>((resolve, reject) => {
    let settled = false;
    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      run.terminate();
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      action();
    };
    const onAbort = (): void => {
      settle(() => reject(new DiffCancelledError()));
    };
    const timer = setTimeout(() => {
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

function prepareSides(beforeHtml: string, afterHtml: string): PreparedSides {
  const parser = new DOMParser();
  const before = parser.parseFromString(
    beforeHtml.replace(/\r\n?/g, "\n"),
    "text/html",
  );
  const after = parser.parseFromString(
    afterHtml.replace(/\r\n?/g, "\n"),
    "text/html",
  );
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
      collapseWhitespace(before.head.innerHTML) ===
        collapseWhitespace(after.head.innerHTML) &&
      collapseWhitespace(beforeBody) === collapseWhitespace(afterBody) &&
      preformattedMarkup(before) === preformattedMarkup(after),
  };
}

function assembleRedline(
  sides: PreparedSides,
  result: EngineSuccess,
  baseHref?: string,
): RedlineResult {
  const { before, after, headDiffers, formattingOnly } = sides;
  const expectedAfter = canonicalBody(after.body);

  after.body.innerHTML = result.html;
  const markerCount = after.body.querySelectorAll(MARKER_SELECTOR).length;
  const original = after.body.cloneNode(true) as HTMLElement;
  const final = after.body.cloneNode(true) as HTMLElement;
  projectBody(original, "before");
  projectBody(final, "after");
  const bodyUnderReported =
    canonicalBody(original) !== canonicalBody(before.body) ||
    canonicalBody(final) !== expectedAfter;
  if (bodyUnderReported)
    throw new Error(
      "Unsupported browser projection: merged content does not preserve both documents",
    );

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

  // Diagnostics identify exact operations. Classify only their owned markers, so an ordinary
  // code-block replacement does not imply that unrelated paragraphs or tables lost precision.
  const coarse = result.diagnostics.filter((d) => d.code === "coarse-replacement");
  const coarseIds = new Set(coarse.map((d) => d.operationId));
  const codeOperations = new Set<string>();
  const otherOperations = new Set<string>();
  for (const marker of after.body.querySelectorAll(MARKER_SELECTOR)) {
    const id = marker.getAttribute("data-diff-op");
    if (!id || !coarseIds.has(id)) continue;
    const isCodeBlock = marker.localName === "pre" && marker.children.length === 1 &&
      marker.firstElementChild?.localName === "code";
    (isCodeBlock ? codeOperations : otherOperations).add(id);
  }

  return {
    html: `<!doctype html>\n${after.documentElement.outerHTML}`,
    markerCount,
    reducedPrecision: coarse.length > 0,
    wholeCodeBlocksOnly: coarse.length > 0 && coarse.every((d) =>
      d.operationId !== undefined && codeOperations.has(d.operationId) &&
      !otherOperations.has(d.operationId),
    ),
    timings: result.timings,
    headDiffers,
    bodyUnderReported,
    formattingOnly,
  };
}

export async function buildRedline(
  beforeHtml: string,
  afterHtml: string,
  baseHref?: string,
  options: EngineOptions = {},
): Promise<RedlineResult> {
  const start = performance.now();
  const sides = prepareSides(beforeHtml, afterHtml);
  const prepared = performance.now();
  const result = await runEngine(sides.beforeBody, sides.afterBody, options);
  const compared = performance.now();
  const assembled = assembleRedline(sides, result, baseHref);
  recordTiming("redline-prepare", start, prepared);
  recordTiming("redline-worker", prepared, compared, result.timings);
  recordTiming("redline-validation", compared, performance.now());
  return assembled;
}

function collapseWhitespace(html: string): string {
  return html.replace(/\s+/g, " ").trim();
}

const PREFORMATTED_SELECTOR =
  "pre, textarea, xmp, listing, plaintext, [style*='white-space']";

function preformattedMarkup(doc: Document): string {
  return [...doc.body.querySelectorAll(PREFORMATTED_SELECTOR)]
    .map((el) => el.outerHTML)
    .join("\u0000");
}

export async function diffHtml(
  beforeHtml: string,
  afterHtml: string,
  baseHref?: string,
): Promise<string> {
  return (await buildRedline(beforeHtml, afterHtml, baseHref)).html;
}

const REDLINE_OWNED_ATTRIBUTES = new Set([
  "data-diff-node",
  "data-operation-index",
  "data-redline-mode",
  "data-redline-current",
]);

export function sanitizeReviewedDocument(doc: Document): void {
  // `*` reaches <html> too, which is where a forged data-redline-mode would sit.
  elements(doc).forEach((el) => {
    if (el.localName === "script") {
      el.remove();
      return;
    }
    if (
      el.localName === "meta" &&
      ["refresh", "content-security-policy"].includes(
        el.getAttribute("http-equiv")?.trim().toLowerCase() ?? "",
      )
    ) {
      el.remove();
      return;
    }
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      // Inline handlers (onclick etc.) survive tag stripping; drop them too.
      if (
        name.startsWith("on") ||
        name.startsWith("data-diff-") ||
        REDLINE_OWNED_ATTRIBUTES.has(name)
      )
        el.removeAttribute(attr.name);
    }
  });
  // Comments are excluded by the host review policy on both sides.
  for (const el of elements(doc)) {
    if (el.localName === "script") el.remove();
    if (el.localName === "template" && "content" in el)
      stripComments((el as HTMLTemplateElement).content);
  }
  stripComments(doc);
}

function stripComments(node: Node): void {
  for (const child of [...node.childNodes]) {
    if (child.nodeType === Node.COMMENT_NODE) child.remove();
    else stripComments(child);
  }
}

/** Bounded performance entries for reproducible browser benchmarks; never retain documents. */
export function recordTiming(
  name: string,
  start: number,
  end = performance.now(),
  detail?: unknown,
): void {
  performance.clearMeasures(name);
  performance.measure(name, { start, end, detail });
}
