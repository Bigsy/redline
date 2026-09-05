import type { EngineSuccess } from "./engine-protocol";
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
import { compareBodies, renderMerged } from "redline-engine";
import { MARKER_SELECTOR, projectBody } from "./review-document";

function doc(body: string, head = ""): string {
  return `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
}

function markers(html: string): Element[] {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  return [...parsed.querySelectorAll(MARKER_SELECTOR)];
}

/**
 * Regressions for THE BUG (PLAN.md decision #2): upstream node-htmldiff builds its atomic-tag
 * regex without a tag-name boundary, so an atomic tag name that prefixes another tag name
 * (`head` -> `<header>`, `video` -> `<video-js>`, `style` -> `<style-guide>`) swallows everything
 * to EOF as one token and the diff silently emits the after document with ZERO markers. The
 * Published-engine exact tag matching must retain these regressions.
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

  it("default tag handling does not swallow changes after header", async () => {
    // Engine-level exact tag matching must not swallow following changed content.
    const result = compareBodies({
      beforeHtml: "<header>same</header><p>old</p>",
      afterHtml: "<header>same</header><p>new</p>",
    });
    if (result.outcome !== "success") throw new Error(result.outcome);
    const merged = renderMerged(result.comparison).html;
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

  it("marks attribute-only replacements", async () => {
    // Documents the limitation the viewer's "changed but unrepresentable" state exists for:
    // if this ever starts producing markers, the engine improved — revisit the banner logic.
    const before = doc('<p class="old">same text</p>');
    const after = doc('<p class="new">same text</p>');
    expect(markers(await diffHtml(before, after)).length).toBeGreaterThan(0);
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
    const after = doc(
      '<script>alert(1)</script><p onclick="alert(2)" class="x">new</p>',
    );
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

  it("refuses Redline's own attributes from a reviewed document", async () => {
    // Every marker and every view-mode decision must have been made by us. See
    // REDLINE_OWNED_ATTRIBUTES: these four are how the engine and the shell talk to the CSS.
    const parsed = new DOMParser().parseFromString(
      '<!doctype html><html data-redline-mode="final"><head></head><body>' +
        '<p data-diff-node="del" data-operation-index="7" data-redline-current="" class="keep">x</p>' +
        "</body></html>",
      "text/html",
    );
    sanitizeReviewedDocument(parsed);
    expect(parsed.documentElement.getAttributeNames()).toEqual([]);
    expect(parsed.querySelector("p")!.getAttributeNames()).toEqual(["class"]);
  });

  it("a document that fakes a deletion gets no marker and no incomplete-highlights warning", async () => {
    // Without the attribute strip: the untouched <li> is painted and counted as a deletion, and
    // reconstructSide drops it from the before side, so bodyUnderReported fires too.
    const faked = '<ul><li data-diff-node="del">untouched</li></ul>';
    const result = await buildRedline(
      doc(`${faked}<p>old text</p>`),
      doc(`${faked}<p>new text</p>`),
    );
    const parsed = new DOMParser().parseFromString(result.html, "text/html");

    expect(parsed.querySelectorAll("li[data-diff-node]")).toHaveLength(0);
    expect(parsed.querySelector("li")!.textContent).toBe("untouched");
    expect(result.bodyUnderReported).toBe(false);
    // The real change is still marked.
    expect(markers(result.html).length).toBeGreaterThan(0);
  });

  it("a document cannot preselect a view mode and hide the other side's changes", async () => {
    const result = await buildRedline(
      "<!doctype html><html><head></head><body><p>old text</p></body></html>",
      '<!doctype html><html data-redline-mode="final"><head></head><body><p>new text</p></body></html>',
    );
    const parsed = new DOMParser().parseFromString(result.html, "text/html");
    expect(parsed.documentElement.hasAttribute("data-redline-mode")).toBe(
      false,
    );
    // The deletion the forged mode would have hidden is present and marked.
    expect(parsed.querySelector("del.redline")).not.toBeNull();
  });

  it("removes a reviewed Content-Security-Policy meta, which would kill our own stylesheet", async () => {
    // CSP policies INTERSECT: a reviewed `style-src 'none'` disables the injected REDLINE_CSS
    // entirely — marker colours, the visibility pins and the view-mode rules — and inserting ours
    // first does not help. The frame's policy is ours to set.
    const hostile =
      '<meta HTTP-EQUIV=" Content-Security-Policy " content="style-src \'none\'">';
    const result = await buildRedline(
      doc("<p>old text</p>"),
      doc("<p>new text</p>", hostile),
    );
    const parsed = new DOMParser().parseFromString(result.html, "text/html");
    const policies = [...parsed.querySelectorAll("meta[http-equiv]")].map((m) =>
      m.getAttribute("content"),
    );

    // Exactly one policy survives: the one assembleRedline adds after sanitization.
    expect(policies).toEqual([DOC_CSP]);
    expect(parsed.querySelector("style")?.textContent).toContain(
      "[data-diff-node]",
    );
  });

  it("a document cannot pass its own ins/del off as engine markers", async () => {
    // A forged marker is painted and counted as a change, and in original/final mode it hides
    // content that really is in that version of the document.
    const forged =
      '<p>keep <del class="redline">forged</del> and <ins class="keep redline">also</ins></p>';
    const result = await buildRedline(
      doc(`${forged}<p>old text</p>`),
      doc(`${forged}<p>new text</p>`),
    );
    const parsed = new DOMParser().parseFromString(result.html, "text/html");

    expect(parsed.querySelectorAll(MARKER_SELECTOR)).toHaveLength(2); // the real change only
    expect(parsed.querySelector("del")!.textContent).toBe("forged"); // the text itself is untouched
    expect(parsed.querySelector("ins.keep")).not.toBeNull(); // and its other classes survive
    expect(result.bodyUnderReported).toBe(false);
  });

  it("removes meta refresh directives (sandbox does NOT block self-navigation)", async () => {
    const parsed = new DOMParser().parseFromString(
      doc(
        "<p>x</p>",
        '<meta HTTP-EQUIV=" Refresh " content="0; url=https://evil.example/">' +
          '<meta http-equiv="content-type" content="text/html">',
      ),
      "text/html",
    );
    sanitizeReviewedDocument(parsed);
    const equivs = [...parsed.querySelectorAll("meta[http-equiv]")].map((m) =>
      m.getAttribute("http-equiv"),
    );
    expect(equivs).toEqual(["content-type"]);
  });
});

describe("view-mode CSS (the shell's Original/Redline/Final control has nothing to drive without it)", () => {
  const styleOf = async () => {
    const result = await buildRedline(
      doc("<p>old text</p>"),
      doc("<p>new text</p>"),
    );
    const parsed = new DOMParser().parseFromString(result.html, "text/html");
    return parsed.querySelector("style")!.textContent ?? "";
  };

  it("projects each side without marker styling or formatting shells", async () => {
    const result = await buildRedline(
      doc("<p>hello world</p>"),
      doc("<p>hello <b>world</b></p>"),
    );
    for (const [side, expected] of [
      ["before", "<p>hello world</p>"],
      ["after", "<p>hello <b>world</b></p>"],
    ] as const) {
      const body = new DOMParser().parseFromString(
        result.html,
        "text/html",
      ).body;
      projectBody(body, side);
      expect(body.innerHTML).toBe(expected);
      expect(body.querySelector(MARKER_SELECTOR)).toBeNull();
    }
  });

  it("marks the current change block without spending the outline the markers already use", async () => {
    expect(await styleOf()).toContain("[data-redline-current] { box-shadow:");
  });
});

describe("under-reporting detection (mixed changes must not be silent)", () => {
  it("marks attribute changes alongside text", async () => {
    const result = await buildRedline(
      doc('<p class="old">old text</p>'),
      doc('<p class="new">new text</p>'),
    );
    expect(result.markerCount).toBeGreaterThan(0);
    expect(result.bodyUnderReported).toBe(false);
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

  it("marks attribute-only changes completely", async () => {
    const result = await buildRedline(
      doc('<p class="old">same text</p>'),
      doc('<p class="new">same text</p>'),
    );
    expect(result.markerCount).toBeGreaterThan(0);
    expect(result.bodyUnderReported).toBe(false);
  });

  it("does not flag a pure text change", async () => {
    const result = await buildRedline(
      doc("<p>old text stays</p>"),
      doc("<p>new text stays</p>"),
    );
    expect(result.markerCount).toBeGreaterThan(0);
    expect(result.headDiffers).toBe(false);
    expect(result.bodyUnderReported).toBe(false);
  });

  it("does not flag added block elements (engine annotates the tag instead of wrapping)", async () => {
    const result = await buildRedline(
      doc(
        "<ol><li>a</li></ol><table><tbody><tr><td>1</td></tr></tbody></table>",
      ),
      doc(
        "<ol><li>a</li><li>b</li></ol><table><tbody><tr><td>1</td></tr><tr><td>2</td></tr></tbody></table>",
      ),
    );
    expect(result.markerCount).toBeGreaterThan(0);
    expect(result.bodyUnderReported).toBe(false);
    // Both row and list item changes annotate the actual structural element.
    const parsed = new DOMParser().parseFromString(result.html, "text/html");
    expect(parsed.querySelector('tr[data-diff-node="insert"]')).not.toBeNull();
    expect(parsed.querySelector('li[data-diff-node="insert"]')).not.toBeNull();
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
    const result = await buildRedline(
      doc("<!-- reviewer note --><p>same</p>"),
      doc("<p>same</p>"),
    );
    expect(result.markerCount).toBe(0);
    expect(result.headDiffers).toBe(false);
    expect(result.bodyUnderReported).toBe(false);
  });

  it("marks a bare-void insertion (<hr>)", async () => {
    // Void insertions are structural markers and must reconstruct exactly.
    const result = await buildRedline(doc("<p>x</p>"), doc("<p>x</p><hr>"));
    expect(result.markerCount).toBeGreaterThan(0);
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
    expect(result.markerCount).toBeGreaterThan(0);
    expect(result.formattingOnly).toBe(true);
  });

  it("does not flag whitespace appearing where there was none (it can change inline layout)", async () => {
    // Collapsing runs deliberately does not erase a run entirely: `<b>a</b><i>b</i>` and
    // `<b>a</b> <i>b</i>` render differently, so this stays the conservative warning state.
    const result = await buildRedline(
      doc("<p><b>a</b><i>b</i></p>"),
      doc("<p><b>a</b> <i>b</i></p>"),
    );
    expect(result.formattingOnly).toBe(false);
  });

  it("flags line-ending-only changes (DOMParser normalises CRLF, so the bodies collapse equal)", async () => {
    const body = "<p>line one</p>\n<p>line two</p>";
    const result = await buildRedline(
      doc(body),
      doc(body.replace(/\n/g, "\r\n")),
    );
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
    const result = await buildRedline(
      doc("<pre>a\n  b</pre>"),
      doc("<pre>a\nb</pre>"),
    );
    expect(result.markerCount).toBeGreaterThan(0); // preformatted changes are atomic replacements
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
    const result = await buildRedline(
      doc('<p class="old">same text</p>'),
      doc('<p class="new">same text</p>'),
    );
    expect(result.markerCount).toBeGreaterThan(0);
    expect(result.formattingOnly).toBe(false);
  });

  it("does not flag head-only changes", async () => {
    const result = await buildRedline(
      doc("<p>x</p>", "<title>old</title>"),
      doc("<p>x</p>", "<title>new</title>"),
    );
    expect(result.formattingOnly).toBe(false);
  });

  it("does not flag real text changes", async () => {
    const result = await buildRedline(
      doc("<p>old text</p>"),
      doc("<p>new text</p>"),
    );
    expect(result.formattingOnly).toBe(false);
  });
});

describe("engine time budget (a big document must not freeze the pane)", () => {
  /** An engine run that never finishes, so only the budget or a cancel can end it. */
  function stalledEngine(): {
    execute: () => { result: Promise<EngineSuccess>; terminate: () => void };
    terminated: () => boolean;
  } {
    let terminated = false;
    return {
      execute: () => ({
        result: new Promise<EngineSuccess>(() => {}),
        terminate: () => (terminated = true),
      }),
      terminated: () => terminated,
    };
  }

  it("resolves through the explicit test worker", async () => {
    const merged = await runEngine("<p>old text</p>", "<p>new text</p>");
    expect(merged.html).toContain("ins");
    expect(merged.html).toContain("new");
  });

  it("compares a whole large document within the normal budget", async () => {
    const paragraphs = 700;
    const makeBody = (edited: boolean): string =>
      Array.from({ length: paragraphs }, (_, i) => {
        const text =
          edited && i % 50 === 0
            ? `Paragraph ${i} was edited to exercise the whole-body comparison.`
            : `Paragraph ${i} is unchanged synthetic prose with enough content to make the whole document large.`;
        return `<p>${text} <b>Bold segment ${i}</b> and <a href="#s${i}">link ${i}</a>.</p>\n`;
      }).join("");

    const result = await buildRedline(
      doc(makeBody(false)),
      doc(makeBody(true)),
    );
    const rendered = new DOMParser().parseFromString(result.html, "text/html");

    expect(result.markerCount).toBeGreaterThanOrEqual(
      Math.ceil(paragraphs / 50) * 2,
    );
    expect(result.bodyUnderReported).toBe(false);
    expect(
      [
        ...rendered.body
          .querySelectorAll("p")[650]
          .querySelectorAll('[data-diff-node="insert"]'),
      ]
        .map((el) => el.textContent)
        .join(""),
    ).toContain("wasedited");
  });

  it("rejects with DiffTimeoutError once the budget is spent, and stops the run", async () => {
    const engine = stalledEngine();
    await expect(
      runEngine("a", "b", { timeoutMs: 5, execute: engine.execute }),
    ).rejects.toBeInstanceOf(DiffTimeoutError);
    expect(engine.terminated()).toBe(true);
  });

  it("carries the budget it gave up on, for the banner text", async () => {
    const engine = stalledEngine();
    const error = await runEngine("a", "b", {
      timeoutMs: 7,
      execute: engine.execute,
    }).catch((e) => e);
    expect(error).toBeInstanceOf(DiffTimeoutError);
    expect((error as DiffTimeoutError).timeoutMs).toBe(7);
  });

  it("rejects with DiffCancelledError when the caller aborts, and stops the run", async () => {
    const engine = stalledEngine();
    const controller = new AbortController();
    const running = runEngine("a", "b", {
      timeoutMs: 60_000,
      signal: controller.signal,
      execute: engine.execute,
    });
    controller.abort();
    await expect(running).rejects.toBeInstanceOf(DiffCancelledError);
    expect(engine.terminated()).toBe(true);
  });

  it("an already-aborted signal never starts waiting", async () => {
    const engine = stalledEngine();
    await expect(
      runEngine("a", "b", {
        timeoutMs: 60_000,
        signal: AbortSignal.abort(),
        execute: engine.execute,
      }),
    ).rejects.toBeInstanceOf(DiffCancelledError);
    expect(engine.terminated()).toBe(false); // No worker was created.
  });

  it("a completed run is not overtaken by a later abort", async () => {
    const controller = new AbortController();
    const merged = await runEngine("<p>a</p>", "<p>b</p>", {
      signal: controller.signal,
    });
    controller.abort();
    expect(merged.html).toContain("ins");
  });
});

describe("document assembly", () => {
  it("injects the CSP meta first, then <base href>", async () => {
    const redline = await diffHtml(
      doc("<p>a</p>"),
      doc("<p>b</p>"),
      "http://host/doc/s1/",
    );
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
    const css = [...parsed.querySelectorAll("style")]
      .map((s) => s.textContent ?? "")
      .join("\n");
    expect(css).toContain("visibility: visible !important");
    expect(css).toMatch(
      /\[data-diff-node="insert"\] \{ background: #d3f2d3 !important/,
    );
  });

  it("keeps the after side's head and injects the redline CSS", async () => {
    const redline = await diffHtml(
      doc("<p>a</p>", "<title>old</title>"),
      doc("<p>b</p>", "<title>new</title><style>p{color:red}</style>"),
    );
    const parsed = new DOMParser().parseFromString(redline, "text/html");
    expect(parsed.title).toBe("new");
    const styles = [...parsed.querySelectorAll("style")].map(
      (s) => s.textContent ?? "",
    );
    expect(styles.some((s) => s.includes("[data-diff-node]"))).toBe(true);
    expect(styles.some((s) => s.includes("color:red"))).toBe(true);
  });
});
