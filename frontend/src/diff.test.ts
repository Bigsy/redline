import { describe, expect, it } from "vitest";

import {
  buildRedline,
  DiffCancelledError,
  DiffTimeoutError,
  DOC_CSP,
  diffHtml,
  runEngine,
  sanitizeReviewedDocument,
} from "./diff";
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
  it("marks changes in documents using <header>", async () => {
    const before = doc("<header><h1>Title</h1></header><p>old text</p>");
    const after = doc("<header><h1>Title</h1></header><p>new text</p>");
    expect(markers(await diffHtml(before, after)).length).toBeGreaterThan(0);
  });

  it("marks changes after a <video-js> custom element (prefix of atomic 'video')", async () => {
    const before = doc("<video-js data-id='1'></video-js><p>old text</p>");
    const after = doc("<video-js data-id='1'></video-js><p>new text</p>");
    expect(markers(await diffHtml(before, after)).length).toBeGreaterThan(0);
  });

  it("marks changes after a <style-guide> custom element (prefix of atomic 'style')", async () => {
    const before = doc("<style-guide>tokens</style-guide><p>old text</p>");
    const after = doc("<style-guide>tokens</style-guide><p>new text</p>");
    expect(markers(await diffHtml(before, after)).length).toBeGreaterThan(0);
  });

  it("patches the engine's DEFAULT atomic-tag list too (head must not match <header>)", async () => {
    // Engine-level: no explicit atomic tags, so the default list (which includes `head`) is used.
    const merged = htmldiff("<header>same</header><p>old</p>", "<header>same</header><p>new</p>");
    expect(merged).toContain("<ins");
    expect(merged).toContain("<del");
  });

  it("still treats real atomic tags as single tokens", async () => {
    const before = doc("<video src='a.mp4'>fallback old</video>");
    const after = doc("<video src='b.mp4'>fallback new</video>");
    const redline = await diffHtml(before, after);
    // The whole element is replaced as one token — no markers nested inside the video element.
    const parsed = new DOMParser().parseFromString(redline, "text/html");
    for (const marker of parsed.querySelectorAll("ins.redline, del.redline")) {
      expect(marker.closest("video")).toBeNull();
    }
    expect(markers(redline).length).toBeGreaterThan(0);
  });
});

describe("truthfulness-relevant behaviour", () => {
  it("produces no markers for identical input", async () => {
    const same = doc("<p>unchanged</p>");
    expect(markers(await diffHtml(same, same))).toHaveLength(0);
  });

  it("produces NO markers for attribute-only changes (known engine limitation)", async () => {
    // Documents the limitation the viewer's "changed but unrepresentable" state exists for:
    // if this ever starts producing markers, the engine improved — revisit the banner logic.
    const before = doc('<p class="old">same text</p>');
    const after = doc('<p class="new">same text</p>');
    expect(markers(await diffHtml(before, after))).toHaveLength(0);
  });

  it("produces NO markers for head-only changes (known engine limitation)", async () => {
    const before = doc("<p>same</p>", "<title>old</title>");
    const after = doc("<p>same</p>", "<title>new</title>");
    expect(markers(await diffHtml(before, after))).toHaveLength(0);
  });
});

describe("sanitization (defense-in-depth behind the sandbox)", () => {
  it("strips <script> elements and inline handlers from the redline", async () => {
    const before = doc("<p>old</p>");
    const after = doc('<script>alert(1)</script><p onclick="alert(2)" class="x">new</p>');
    const redline = await diffHtml(before, after);
    const parsed = new DOMParser().parseFromString(redline, "text/html");
    expect(parsed.querySelector("script")).toBeNull();
    expect(redline).not.toContain("onclick");
    expect(parsed.querySelector("p.x")).not.toBeNull(); // non-handler attributes survive
  });

  it("sanitizeReviewedDocument drops every on* attribute", async () => {
    const parsed = new DOMParser().parseFromString(
      doc('<a href="#" onmouseover="x()" onfocus="y()" title="keep">link</a>'),
      "text/html",
    );
    sanitizeReviewedDocument(parsed);
    const a = parsed.querySelector("a")!;
    expect(a.getAttributeNames().sort()).toEqual(["href", "title"]);
  });

  it("removes meta refresh directives (sandbox does NOT block self-navigation)", async () => {
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
  it("flags attribute changes riding along with marked text changes", async () => {
    const result = await buildRedline(doc('<p class="old">old text</p>'), doc('<p class="new">new text</p>'));
    expect(result.markerCount).toBeGreaterThan(0);
    expect(result.bodyUnderReported).toBe(true);
    expect(result.headDiffers).toBe(false);
  });

  it("flags head changes riding along with marked body changes", async () => {
    const result = await buildRedline(
      doc("<p>old</p>", "<title>old title</title>"),
      doc("<p>new</p>", "<title>new title</title>"),
    );
    expect(result.markerCount).toBeGreaterThan(0);
    expect(result.headDiffers).toBe(true);
    expect(result.bodyUnderReported).toBe(false);
  });

  it("flags attribute-only changes (zero markers)", async () => {
    const result = await buildRedline(doc('<p class="old">same text</p>'), doc('<p class="new">same text</p>'));
    expect(result.markerCount).toBe(0);
    expect(result.bodyUnderReported).toBe(true);
  });

  it("does not flag a pure text change", async () => {
    const result = await buildRedline(doc("<p>old text stays</p>"), doc("<p>new text stays</p>"));
    expect(result.markerCount).toBeGreaterThan(0);
    expect(result.headDiffers).toBe(false);
    expect(result.bodyUnderReported).toBe(false);
  });

  it("does not flag added block elements (engine annotates the tag instead of wrapping)", async () => {
    const result = await buildRedline(
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

  it("does not flag removed block elements", async () => {
    const result = await buildRedline(
      doc("<ul><li>keep</li><li>drop me</li></ul>"),
      doc("<ul><li>keep</li></ul>"),
    );
    expect(result.markerCount).toBeGreaterThan(0);
    expect(result.bodyUnderReported).toBe(false);
  });

  it("ignores comment-only differences (the tokenizer drops comments anyway)", async () => {
    const result = await buildRedline(doc("<!-- reviewer note --><p>same</p>"), doc("<p>same</p>"));
    expect(result.markerCount).toBe(0);
    expect(result.headDiffers).toBe(false);
    expect(result.bodyUnderReported).toBe(false);
  });

  it("an unmarkable bare-void insertion (<hr>) surfaces via the zero-marker state, unflagged", async () => {
    // The engine emits the inserted <hr> with neither a wrapper nor an annotation. It is NOT
    // flagged as under-reported (empty attribute-less elements are comparison noise — see
    // normalizeForComparison), but with zero markers and differing inputs the viewer still
    // reaches the "changed but unrepresentable" banner, so the change is never silent.
    const result = await buildRedline(doc("<p>x</p>"), doc("<p>x</p><hr>"));
    expect(result.markerCount).toBe(0);
    expect(result.bodyUnderReported).toBe(false);
  });

  it("does not flag identical documents", async () => {
    const same = doc('<p class="x">unchanged</p>', "<title>t</title>");
    const result = await buildRedline(same, same);
    expect(result.markerCount).toBe(0);
    expect(result.headDiffers).toBe(false);
    expect(result.bodyUnderReported).toBe(false);
  });

  it("does not flag a script-only head difference (scripts are stripped from both sides)", async () => {
    const result = await buildRedline(
      doc("<p>old</p>", "<script>a()</script><title>t</title>"),
      doc("<p>new</p>", "<title>t</title>"),
    );
    expect(result.headDiffers).toBe(false);
  });
});

describe("formatting-only detection (whitespace/CRLF edits are not under-reporting)", () => {
  it("flags reindentation (whitespace runs resized)", async () => {
    const result = await buildRedline(
      doc("\n  <p>same text</p>\n  <p>more</p>\n"),
      doc("\n\t\t\t<p>same text</p>\n\n\t\t\t<p>more</p>\n\n"),
    );
    expect(result.markerCount).toBe(0);
    expect(result.formattingOnly).toBe(true);
  });

  it("does not flag whitespace appearing where there was none (it can change inline layout)", async () => {
    // Collapsing runs deliberately does not erase a run entirely: `<b>a</b><i>b</i>` and
    // `<b>a</b> <i>b</i>` render differently, so this stays the conservative warning state.
    const result = await buildRedline(doc("<p><b>a</b><i>b</i></p>"), doc("<p><b>a</b> <i>b</i></p>"));
    expect(result.formattingOnly).toBe(false);
  });

  it("flags line-ending-only changes (DOMParser normalises CRLF, so the bodies collapse equal)", async () => {
    const body = "<p>line one</p>\n<p>line two</p>";
    const result = await buildRedline(doc(body), doc(body.replace(/\n/g, "\r\n")));
    expect(result.formattingOnly).toBe(true);
  });

  it("flags whitespace-only head changes alongside a whitespace-only body change", async () => {
    const result = await buildRedline(
      doc("<p>x</p>", "<title>t</title>"),
      doc("<p>x</p> ", "<title>t</title>\n"),
    );
    expect(result.formattingOnly).toBe(true);
  });

  it("does not flag reindented <pre> content (whitespace there is rendered verbatim)", async () => {
    const result = await buildRedline(doc("<pre>a\n  b</pre>"), doc("<pre>a\nb</pre>"));
    expect(result.markerCount).toBe(0); // the engine cannot mark it — the banner is all there is
    expect(result.formattingOnly).toBe(false);
  });

  it("does not flag whitespace changes inside an inline white-space:pre style", async () => {
    const result = await buildRedline(
      doc('<p style="white-space: pre">a  b</p>'),
      doc('<p style="white-space: pre">a b</p>'),
    );
    expect(result.formattingOnly).toBe(false);
  });

  it("still flags reindentation AROUND an untouched <pre>", async () => {
    const result = await buildRedline(
      doc("<pre>a\n  b</pre>\n<p>t</p>"),
      doc("<pre>a\n  b</pre>\n\n\t<p>t</p>"),
    );
    expect(result.formattingOnly).toBe(true);
  });

  it("does not flag attribute-only changes", async () => {
    const result = await buildRedline(doc('<p class="old">same text</p>'), doc('<p class="new">same text</p>'));
    expect(result.markerCount).toBe(0);
    expect(result.formattingOnly).toBe(false);
  });

  it("does not flag head-only changes", async () => {
    const result = await buildRedline(doc("<p>x</p>", "<title>old</title>"), doc("<p>x</p>", "<title>new</title>"));
    expect(result.formattingOnly).toBe(false);
  });

  it("does not flag real text changes", async () => {
    const result = await buildRedline(doc("<p>old text</p>"), doc("<p>new text</p>"));
    expect(result.formattingOnly).toBe(false);
  });
});

describe("engine time budget (a big document must not freeze the pane)", () => {
  /** An engine run that never finishes, so only the budget or a cancel can end it. */
  function stalledEngine(): { execute: () => { result: Promise<string>; terminate: () => void }; terminated: () => boolean } {
    let terminated = false;
    return {
      execute: () => ({ result: new Promise<string>(() => {}), terminate: () => (terminated = true) }),
      terminated: () => terminated,
    };
  }

  it("resolves through the inline path (no Worker in happy-dom)", async () => {
    const merged = await runEngine("<p>old text</p>", "<p>new text</p>");
    expect(merged).toContain("ins");
    expect(merged).toContain("new");
  });

  it("rejects with DiffTimeoutError once the budget is spent, and stops the run", async () => {
    const engine = stalledEngine();
    await expect(runEngine("a", "b", { timeoutMs: 5, execute: engine.execute })).rejects.toBeInstanceOf(
      DiffTimeoutError,
    );
    expect(engine.terminated()).toBe(true);
  });

  it("carries the budget it gave up on, for the banner text", async () => {
    const engine = stalledEngine();
    const error = await runEngine("a", "b", { timeoutMs: 7, execute: engine.execute }).catch((e) => e);
    expect(error).toBeInstanceOf(DiffTimeoutError);
    expect((error as DiffTimeoutError).timeoutMs).toBe(7);
  });

  it("rejects with DiffCancelledError when the caller aborts, and stops the run", async () => {
    const engine = stalledEngine();
    const controller = new AbortController();
    const running = runEngine("a", "b", { timeoutMs: 60_000, signal: controller.signal, execute: engine.execute });
    controller.abort();
    await expect(running).rejects.toBeInstanceOf(DiffCancelledError);
    expect(engine.terminated()).toBe(true);
  });

  it("an already-aborted signal never starts waiting", async () => {
    const engine = stalledEngine();
    await expect(
      runEngine("a", "b", { timeoutMs: 60_000, signal: AbortSignal.abort(), execute: engine.execute }),
    ).rejects.toBeInstanceOf(DiffCancelledError);
    expect(engine.terminated()).toBe(true);
  });

  it("a completed run is not overtaken by a later abort", async () => {
    const controller = new AbortController();
    const merged = await runEngine("<p>a</p>", "<p>b</p>", { signal: controller.signal });
    controller.abort();
    expect(merged).toContain("ins");
  });
});

describe("document assembly", () => {
  it("injects the CSP meta first, then <base href>", async () => {
    const redline = await diffHtml(doc("<p>a</p>"), doc("<p>b</p>"), "http://host/doc/s1/");
    const parsed = new DOMParser().parseFromString(redline, "text/html");
    const [first, second] = [...parsed.head.children];
    expect(first.getAttribute("http-equiv")).toBe("Content-Security-Policy");
    expect(first.getAttribute("content")).toBe(DOC_CSP);
    expect(DOC_CSP).toContain("default-src 'self' data:");
    expect(second.tagName).toBe("BASE");
    expect(second.getAttribute("href")).toBe("http://host/doc/s1/");
  });

  it("pins the marker styles against reviewed CSS (!important on visibility-critical props)", async () => {
    const redline = await diffHtml(doc("<p>a</p>"), doc("<p>b</p>"));
    const parsed = new DOMParser().parseFromString(redline, "text/html");
    const css = [...parsed.querySelectorAll("style")].map((s) => s.textContent ?? "").join("\n");
    expect(css).toContain("visibility: visible !important");
    expect(css).toMatch(/ins\.redline \{ background: #d3f2d3 !important/);
  });

  it("keeps the after side's head and injects the redline CSS", async () => {
    const redline = await diffHtml(
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
