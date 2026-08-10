import { describe, expect, it } from "vitest";

import { buildRedline, DOC_CSP, diffHtml, sanitizeReviewedDocument } from "./diff";
import htmldiff from "./vendor/htmldiff";

function doc(body: string, head = ""): string {
  return `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
}

function markers(html: string): Element[] {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  return [...parsed.querySelectorAll("ins.redline, del.redline")];
}

/**
 * Regressions for THE BUG (PLAN.md decision #2): upstream node-htmldiff builds its atomic-tag
 * regex without a tag-name boundary, so an atomic tag name that prefixes another tag name
 * (`head` -> `<header>`, `video` -> `<video-js>`, `style` -> `<style-guide>`) swallows everything
 * to EOF as one token and the diff silently emits the after document with ZERO markers. The
 * vendored engine patches the regex with `(?=[\s/>])`; these must keep producing markers.
 */
describe("atomic-tag boundary regressions", () => {
  it("marks changes in documents using <header>", () => {
    const before = doc("<header><h1>Title</h1></header><p>old text</p>");
    const after = doc("<header><h1>Title</h1></header><p>new text</p>");
    expect(markers(diffHtml(before, after)).length).toBeGreaterThan(0);
  });

  it("marks changes after a <video-js> custom element (prefix of atomic 'video')", () => {
    const before = doc("<video-js data-id='1'></video-js><p>old text</p>");
    const after = doc("<video-js data-id='1'></video-js><p>new text</p>");
    expect(markers(diffHtml(before, after)).length).toBeGreaterThan(0);
  });

  it("marks changes after a <style-guide> custom element (prefix of atomic 'style')", () => {
    const before = doc("<style-guide>tokens</style-guide><p>old text</p>");
    const after = doc("<style-guide>tokens</style-guide><p>new text</p>");
    expect(markers(diffHtml(before, after)).length).toBeGreaterThan(0);
  });

  it("patches the engine's DEFAULT atomic-tag list too (head must not match <header>)", () => {
    // Engine-level: no explicit atomic tags, so the default list (which includes `head`) is used.
    const merged = htmldiff("<header>same</header><p>old</p>", "<header>same</header><p>new</p>");
    expect(merged).toContain("<ins");
    expect(merged).toContain("<del");
  });

  it("still treats real atomic tags as single tokens", () => {
    const before = doc("<video src='a.mp4'>fallback old</video>");
    const after = doc("<video src='b.mp4'>fallback new</video>");
    const redline = diffHtml(before, after);
    // The whole element is replaced as one token — no markers nested inside the video element.
    const parsed = new DOMParser().parseFromString(redline, "text/html");
    for (const marker of parsed.querySelectorAll("ins.redline, del.redline")) {
      expect(marker.closest("video")).toBeNull();
    }
    expect(markers(redline).length).toBeGreaterThan(0);
  });
});

describe("truthfulness-relevant behaviour", () => {
  it("produces no markers for identical input", () => {
    const same = doc("<p>unchanged</p>");
    expect(markers(diffHtml(same, same))).toHaveLength(0);
  });

  it("produces NO markers for attribute-only changes (known engine limitation)", () => {
    // Documents the limitation the viewer's "changed but unrepresentable" state exists for:
    // if this ever starts producing markers, the engine improved — revisit the banner logic.
    const before = doc('<p class="old">same text</p>');
    const after = doc('<p class="new">same text</p>');
    expect(markers(diffHtml(before, after))).toHaveLength(0);
  });

  it("produces NO markers for head-only changes (known engine limitation)", () => {
    const before = doc("<p>same</p>", "<title>old</title>");
    const after = doc("<p>same</p>", "<title>new</title>");
    expect(markers(diffHtml(before, after))).toHaveLength(0);
  });
});

describe("sanitization (defense-in-depth behind the sandbox)", () => {
  it("strips <script> elements and inline handlers from the redline", () => {
    const before = doc("<p>old</p>");
    const after = doc('<script>alert(1)</script><p onclick="alert(2)" class="x">new</p>');
    const redline = diffHtml(before, after);
    const parsed = new DOMParser().parseFromString(redline, "text/html");
    expect(parsed.querySelector("script")).toBeNull();
    expect(redline).not.toContain("onclick");
    expect(parsed.querySelector("p.x")).not.toBeNull(); // non-handler attributes survive
  });

  it("sanitizeReviewedDocument drops every on* attribute", () => {
    const parsed = new DOMParser().parseFromString(
      doc('<a href="#" onmouseover="x()" onfocus="y()" title="keep">link</a>'),
      "text/html",
    );
    sanitizeReviewedDocument(parsed);
    const a = parsed.querySelector("a")!;
    expect(a.getAttributeNames().sort()).toEqual(["href", "title"]);
  });

  it("removes meta refresh directives (sandbox does NOT block self-navigation)", () => {
    const parsed = new DOMParser().parseFromString(
      doc("<p>x</p>", '<meta HTTP-EQUIV=" Refresh " content="0; url=https://evil.example/">' +
        '<meta http-equiv="content-type" content="text/html">'),
      "text/html",
    );
    sanitizeReviewedDocument(parsed);
    const equivs = [...parsed.querySelectorAll("meta[http-equiv]")].map((m) => m.getAttribute("http-equiv"));
    expect(equivs).toEqual(["content-type"]);
  });
});

describe("under-reporting detection (mixed changes must not be silent)", () => {
  it("flags attribute changes riding along with marked text changes", () => {
    const result = buildRedline(doc('<p class="old">old text</p>'), doc('<p class="new">new text</p>'));
    expect(result.markerCount).toBeGreaterThan(0);
    expect(result.bodyUnderReported).toBe(true);
    expect(result.headDiffers).toBe(false);
  });

  it("flags head changes riding along with marked body changes", () => {
    const result = buildRedline(
      doc("<p>old</p>", "<title>old title</title>"),
      doc("<p>new</p>", "<title>new title</title>"),
    );
    expect(result.markerCount).toBeGreaterThan(0);
    expect(result.headDiffers).toBe(true);
    expect(result.bodyUnderReported).toBe(false);
  });

  it("flags attribute-only changes (zero markers)", () => {
    const result = buildRedline(doc('<p class="old">same text</p>'), doc('<p class="new">same text</p>'));
    expect(result.markerCount).toBe(0);
    expect(result.bodyUnderReported).toBe(true);
  });

  it("does not flag a pure text change", () => {
    const result = buildRedline(doc("<p>old text stays</p>"), doc("<p>new text stays</p>"));
    expect(result.markerCount).toBeGreaterThan(0);
    expect(result.headDiffers).toBe(false);
    expect(result.bodyUnderReported).toBe(false);
  });

  it("does not flag added block elements (engine annotates the tag instead of wrapping)", () => {
    const result = buildRedline(
      doc("<ol><li>a</li></ol><table><tbody><tr><td>1</td></tr></tbody></table>"),
      doc("<ol><li>a</li><li>b</li></ol><table><tbody><tr><td>1</td></tr><tr><td>2</td></tr></tbody></table>"),
    );
    expect(result.markerCount).toBeGreaterThan(0);
    expect(result.bodyUnderReported).toBe(false);
    // Document the two shapes this test exists for: the row is ANNOTATED in place, while the
    // list item takes the tag-alignment-shift shape (tags matched as equal, only text wrapped,
    // leaving a phantom empty <li> in the naive reconstruction).
    const parsed = new DOMParser().parseFromString(result.html, "text/html");
    expect(parsed.querySelector('tr[data-diff-node="ins"]')).not.toBeNull();
    expect(parsed.querySelector("li ins.redline")).not.toBeNull();
  });

  it("does not flag removed block elements", () => {
    const result = buildRedline(
      doc("<ul><li>keep</li><li>drop me</li></ul>"),
      doc("<ul><li>keep</li></ul>"),
    );
    expect(result.markerCount).toBeGreaterThan(0);
    expect(result.bodyUnderReported).toBe(false);
  });

  it("ignores comment-only differences (the tokenizer drops comments anyway)", () => {
    const result = buildRedline(doc("<!-- reviewer note --><p>same</p>"), doc("<p>same</p>"));
    expect(result.markerCount).toBe(0);
    expect(result.headDiffers).toBe(false);
    expect(result.bodyUnderReported).toBe(false);
  });

  it("an unmarkable bare-void insertion (<hr>) surfaces via the zero-marker state, unflagged", () => {
    // The engine emits the inserted <hr> with neither a wrapper nor an annotation. It is NOT
    // flagged as under-reported (empty attribute-less elements are comparison noise — see
    // normalizeForComparison), but with zero markers and differing inputs the viewer still
    // reaches the "changed but unrepresentable" banner, so the change is never silent.
    const result = buildRedline(doc("<p>x</p>"), doc("<p>x</p><hr>"));
    expect(result.markerCount).toBe(0);
    expect(result.bodyUnderReported).toBe(false);
  });

  it("does not flag identical documents", () => {
    const same = doc('<p class="x">unchanged</p>', "<title>t</title>");
    const result = buildRedline(same, same);
    expect(result.markerCount).toBe(0);
    expect(result.headDiffers).toBe(false);
    expect(result.bodyUnderReported).toBe(false);
  });

  it("does not flag a script-only head difference (scripts are stripped from both sides)", () => {
    const result = buildRedline(
      doc("<p>old</p>", "<script>a()</script><title>t</title>"),
      doc("<p>new</p>", "<title>t</title>"),
    );
    expect(result.headDiffers).toBe(false);
  });
});

describe("document assembly", () => {
  it("injects the CSP meta first, then <base href>", () => {
    const redline = diffHtml(doc("<p>a</p>"), doc("<p>b</p>"), "http://host/doc/s1/");
    const parsed = new DOMParser().parseFromString(redline, "text/html");
    const [first, second] = [...parsed.head.children];
    expect(first.getAttribute("http-equiv")).toBe("Content-Security-Policy");
    expect(first.getAttribute("content")).toBe(DOC_CSP);
    expect(DOC_CSP).toContain("default-src 'self' data:");
    expect(second.tagName).toBe("BASE");
    expect(second.getAttribute("href")).toBe("http://host/doc/s1/");
  });

  it("pins the marker styles against reviewed CSS (!important on visibility-critical props)", () => {
    const redline = diffHtml(doc("<p>a</p>"), doc("<p>b</p>"));
    const parsed = new DOMParser().parseFromString(redline, "text/html");
    const css = [...parsed.querySelectorAll("style")].map((s) => s.textContent ?? "").join("\n");
    expect(css).toContain("visibility: visible !important");
    expect(css).toMatch(/ins\.redline \{ background: #d3f2d3 !important/);
  });

  it("keeps the after side's head and injects the redline CSS", () => {
    const redline = diffHtml(
      doc("<p>a</p>", "<title>old</title>"),
      doc("<p>b</p>", "<title>new</title><style>p{color:red}</style>"),
    );
    const parsed = new DOMParser().parseFromString(redline, "text/html");
    expect(parsed.title).toBe("new");
    const styles = [...parsed.querySelectorAll("style")].map((s) => s.textContent ?? "");
    expect(styles.some((s) => s.includes("ins.redline"))).toBe(true);
    expect(styles.some((s) => s.includes("color:red"))).toBe(true);
  });
});
