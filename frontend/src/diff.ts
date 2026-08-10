// Vendored engine (MIT) with the atomic-tag boundary patch — see vendor/htmldiff.js header.
import htmldiff from "./vendor/htmldiff";

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
  ins.redline, del.redline {
    visibility: visible !important;
    opacity: 1 !important;
    content-visibility: visible !important;
  }
  ins.redline { background: #d3f2d3 !important; color: #1a1a1a !important; text-decoration: none !important; outline: 1px solid #7ac47a !important; }
  del.redline { background: #f8d7d7 !important; color: #1a1a1a !important; text-decoration: line-through !important; outline: 1px solid #d98c8c !important; }
  ins.redline img { outline: 3px solid #7ac47a !important; }
  del.redline img { outline: 3px solid #d98c8c !important; }
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
  /** Number of ins/del markers in the merged body. */
  markerCount: number;
  /** The two heads differ; head changes are invisible by design (after head is kept). */
  headDiffers: boolean;
  /**
   * The merged body does not fully represent the before side — attribute-only changes the
   * engine silently resolves to the after markup. Detected by reconstructing the before side
   * from the redline (drop ins, unwrap del) and comparing with the real one.
   */
  bodyUnderReported: boolean;
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
 * @param baseHref When given, injected as `<base href>` in `<head>` so the document's relative
 *   asset URLs resolve against the session's `/doc/<session>/` routes rather than the shell page.
 *
 * Scripts and refresh directives are stripped as defense-in-depth; the structural guarantees are
 * the shell's sandboxed iframe (no `allow-scripts`) plus the injected CSP and the Kotlin-side
 * navigation guard.
 */
export function buildRedline(beforeHtml: string, afterHtml: string, baseHref?: string): RedlineResult {
  const parser = new DOMParser();
  const before = parser.parseFromString(beforeHtml, "text/html");
  const after = parser.parseFromString(afterHtml, "text/html");
  sanitizeReviewedDocument(before);
  sanitizeReviewedDocument(after);

  const headDiffers = before.head.innerHTML !== after.head.innerHTML;
  const beforeBody = before.body.innerHTML;

  const redlineBody = htmldiff(beforeBody, after.body.innerHTML, "redline", null, ATOMIC_TAGS);

  after.body.innerHTML = redlineBody;
  const markerCount = after.body.querySelectorAll("ins.redline, del.redline").length;
  const bodyUnderReported = normalizeForComparison(reconstructSide(after.body, "before")) !== normalizeForComparison(beforeBody);

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
  };
}

/** Back-compat/test convenience: just the merged document. */
export function diffHtml(beforeHtml: string, afterHtml: string, baseHref?: string): string {
  return buildRedline(beforeHtml, afterHtml, baseHref).html;
}

/**
 * Rebuild one side's body markup from the merged redline: the before side is everything except
 * insertions (drop `ins`, unwrap `del`); the after side is the mirror image. If the rebuilt
 * before side differs from the real one, the redline under-reports (attribute-only changes).
 */
function reconstructSide(mergedBody: Element, side: "before" | "after"): string {
  const clone = mergedBody.cloneNode(true) as Element;
  clone.querySelectorAll(side === "before" ? "ins.redline" : "del.redline").forEach((node) => node.remove());
  clone.querySelectorAll(side === "before" ? "del.redline" : "ins.redline").forEach((node) => node.replaceWith(...node.childNodes));
  return clone.innerHTML;
}

/** Whitespace-insensitive comparison: tokenization may rearrange runs, and whitespace-only
 * differences are invisible in rendered HTML anyway. */
function normalizeForComparison(html: string): string {
  return html.replace(/\s+/g, " ").trim();
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
}
