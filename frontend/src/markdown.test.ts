import { describe, expect, it } from "vitest";
import { MARKDOWN_INPUT_LIMIT, MarkdownLimitError, renderMarkdown } from "./markdown";
import { buildRedline, sanitizeReviewedDocument } from "./diff";

function documentFor(markdown: string): string {
  return renderMarkdown(markdown);
}

describe("Markdown preparation", () => {
  it("rejects oversized input and rendered output before handing it to the host", () => {
    expect(() => renderMarkdown("x".repeat(MARKDOWN_INPUT_LIMIT + 1))).toThrowError(
      new MarkdownLimitError("input"),
    );
    // Repeated short paragraphs exercise the expansion cap without relying on a browser DOM.
    const source = Array.from({ length: 120_000 }, () => "paragraph").join("\n\n");
    expect(source.length).toBeLessThan(MARKDOWN_INPUT_LIMIT);
    expect(() => renderMarkdown(source)).toThrowError(
      new MarkdownLimitError("output"),
    );
  });

  it("renders GFM prose, headings, links, tasks, tables, quotes and fenced code", () => {
    const html = renderMarkdown(
      "# Heading\n\nA **bold** [link](https://example.test).\n\n> quote\n\n- [x] done\n- item\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n```ts\nconst x = 1;\n```",
    );
    expect(html).toContain("<h1>Heading</h1>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<table>");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("<pre><code class=\"language-ts\">");
  });

  it("keeps Markdown formatting and escaping inside table cells", () => {
    const html = renderMarkdown(
      "| Emphasis | Code | Link | Literal |\n| --- | --- | --- | --- |\n| **bold** | `const x` | [docs](https://example.test) | &lt;tag&gt; |",
    );
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<code>const x</code>");
    expect(html).toContain('<a href="https://example.test">docs</a>');
    expect(html).toContain("&lt;tag&gt;");
    expect(html).not.toContain("<tag>");
  });

  it("keeps YAML and TOML frontmatter in a labelled escaped metadata block", () => {
    for (const [source, escaped] of [
      ["---\ntitle: <unsafe>\n---\n\n# Body", "&lt;unsafe&gt;"],
      ["+++\ntitle = \"safe\"\n+++\n\n# Body", "title = &quot;safe&quot;"],
    ]) {
      const html = renderMarkdown(source);
      expect(html).toContain('class="redline-frontmatter"');
      expect(html).toContain('class="redline-frontmatter-source"');
      expect(html).toContain(escaped);
      expect(html).not.toContain("<h1>title");
      expect(html).toContain("<h1>Body</h1>");
    }
  });

  it("preserves frontmatter indentation and leading blank lines", () => {
    const source = "---\n\n  title: Care summary\n    owner: Team <safe>\n---\n\n# Summary";
    const html = renderMarkdown(source);
    const doc = new DOMParser().parseFromString(html, "text/html");
    expect(doc.querySelector(".redline-frontmatter-source")?.textContent).toBe(
      "\n  title: Care summary\n    owner: Team <safe>",
    );
    expect(html).toContain("Team &lt;safe&gt;");
  });

  it("handles unterminated frontmatter without inventing a heading", () => {
    const html = renderMarkdown("---\ntitle: value\n# still metadata");
    expect(html).toContain("Unterminated frontmatter");
    expect(html).not.toContain("<h1>title");
  });

  it("does not treat an indented YAML fence as the end of frontmatter", () => {
    const html = renderMarkdown("---\nscript: |\n  ---\n  still metadata\n---\n\n# Body");
    expect(html).toContain("  ---");
    expect(html).toContain("still metadata");
    expect(html).toContain("<h1>Body</h1>");
  });

  it("keeps changed table cells precise when rows are inserted", async () => {
    const result = await buildRedline(
      documentFor("| Measure | Value |\n| --- | ---: |\n| Pulse | 72 |\n| Oxygen | 97 |"),
      documentFor("| Measure | Value |\n| --- | ---: |\n| Pulse | 76 |\n| Oxygen | 98 |\n| Temperature | 36.7 |"),
    );
    const doc = new DOMParser().parseFromString(result.html, "text/html");
    expect(result.reducedPrecision).toBe(false);
    expect(result.bodyUnderReported).toBe(false);
    expect(doc.querySelector("tbody[data-diff-node]")).toBeNull();
    expect(doc.querySelectorAll("td[data-diff-node], td > ins.redline, td > del.redline").length).toBeGreaterThan(0);
    expect(doc.querySelector("tbody tr:last-child td")?.textContent).toContain("Temperature");
  });

  it("keeps changed frontmatter values precise in a separate metadata block", async () => {
    const result = await buildRedline(
      documentFor("---\ntitle: Care summary\nstatus: draft\n---\n\n# Summary"),
      documentFor("---\ntitle: Care summary\nstatus: published\n---\n\n# Summary"),
    );
    const doc = new DOMParser().parseFromString(result.html, "text/html");
    expect(result.reducedPrecision).toBe(false);
    expect(result.bodyUnderReported).toBe(false);
    expect(doc.querySelector(".redline-frontmatter[data-diff-node]")).toBeNull();
    expect(doc.querySelector(".redline-frontmatter-source ins.redline, .redline-frontmatter-source del.redline")).not.toBeNull();
    expect(doc.querySelector("h1")?.textContent).toBe("Summary");
  });

  it("passes raw HTML through the existing reviewed document sanitizer", () => {
    const html = renderMarkdown('<script>alert(1)</script><img src="https://evil.example/x">');
    const doc = new DOMParser().parseFromString(html, "text/html");
    sanitizeReviewedDocument(doc);
    expect(doc.querySelector("script")).toBeNull();
    // The CSP added by the viewer blocks remote image fetches; the source remains visible as a
    // normal reviewed attribute so the existing HTML policy is applied consistently.
    expect(doc.querySelector("img")?.getAttribute("src")).toBe("https://evil.example/x");
  });
});
