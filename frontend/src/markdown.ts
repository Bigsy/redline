import { marked, Renderer } from "marked";

/** Markdown is parsed in a worker and then checked again by the host. */
export const MARKDOWN_INPUT_LIMIT = 2_000_000;
export const MARKDOWN_OUTPUT_LIMIT = 2_000_000;

export class MarkdownLimitError extends Error {
  constructor(readonly limit: "input" | "output") {
    super(`Markdown ${limit} limit exceeded`);
    this.name = "MarkdownLimitError";
  }
}

const FRONTMATTER_RE = /^(?:\uFEFF)?(---|\+\+\+)[ \t]*\r?\n/;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * Keep YAML/TOML frontmatter visible as metadata. Marked otherwise treats a leading `---` as a
 * thematic break and the first metadata line as a heading, which is misleading in a rendered
 * comparison. Preserve the metadata verbatim rather than interpreting its keys or indentation.
 */
function splitFrontmatter(source: string): { metadata: string | null; body: string } {
  const start = FRONTMATTER_RE.exec(source);
  if (!start) return { metadata: null, body: source };
  const closingFence = start[1];
  const remainder = source.slice(start[0].length);
  const lines = remainder.split(/\r?\n/);
  const fencePattern = closingFence === "---" ? /^---[ \t]*$/ : /^\+\+\+[ \t]*$/;
  const end = lines.findIndex((line) =>
    fencePattern.test(line) || (closingFence === "---" && /^\.\.\.[ \t]*$/.test(line)),
  );
  if (end < 0) {
    // An unterminated block is still metadata, but the explicit label prevents it becoming a
    // fake heading/table and makes the malformed source visible in both sides of the diff.
    return {
      metadata: `Unterminated frontmatter\n${remainder}`,
      body: "",
    };
  }
  return { metadata: lines.slice(0, end).join("\n"), body: lines.slice(end + 1).join("\n") };
}

function metadataHtml(metadata: string): string {
  return `<section class="redline-frontmatter" aria-label="Document metadata"><h2>Document metadata</h2><div class="redline-frontmatter-source">${escapeHtml(metadata)}</div></section>`;
}

export const MARKDOWN_STYLE = `
  :root { color-scheme: light dark; background: #fff; }
  body.redline-markdown { min-height: 100vh; margin: 0 auto; max-width: 70rem; padding: 2rem 3rem 5rem; box-sizing: border-box; color: #242629; background: #fff; font: 15px/1.6 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  .redline-markdown h1, .redline-markdown h2, .redline-markdown h3, .redline-markdown h4, .redline-markdown h5, .redline-markdown h6 { line-height: 1.25; margin: 1.5em 0 .55em; }
  .redline-markdown h1 { font-size: 2em; } .redline-markdown h2 { font-size: 1.5em; }
  .redline-markdown p, .redline-markdown ul, .redline-markdown ol, .redline-markdown blockquote, .redline-markdown pre, .redline-markdown table { margin: .85em 0; }
  .redline-markdown a { color: #075fbd; } .redline-markdown blockquote { border-left: 4px solid #b7bdc7; margin-left: 0; padding: .1em 1em; color: #555b66; }
  .redline-markdown pre { overflow-x: auto; padding: 1rem; border-radius: 6px; background: #f1f3f5; } .redline-markdown code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .92em; } .redline-markdown :not(pre) > code { padding: .12em .3em; border-radius: 3px; background: #eef0f2; }
  .redline-markdown table { border-collapse: collapse; width: 100%; } .redline-markdown th, .redline-markdown td { border: 1px solid #c8ccd2; padding: .45em .65em; text-align: left; vertical-align: top; } .redline-markdown th { background: #eef0f2; }
  .redline-markdown input[type="checkbox"] { margin-right: .45em; } .redline-frontmatter { border: 1px solid #c8ccd2; border-radius: 6px; padding: .7rem 1rem; margin-bottom: 2rem; background: #f8f9fa; } .redline-frontmatter h2 { font-size: 1rem; margin: 0 0 .4rem; } .redline-frontmatter-source { white-space: pre-wrap; overflow-wrap: anywhere; font: .92em/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  [data-redline-theme="dark"] { background: #2b2d30; } [data-redline-theme="dark"] body.redline-markdown { color: #dfe1e5; background: #2b2d30; } [data-redline-theme="dark"] .redline-markdown a { color: #6ea8ff; } [data-redline-theme="dark"] .redline-markdown blockquote { color: #b9bec8; border-left-color: #646a73; } [data-redline-theme="dark"] .redline-markdown pre { background: #202225; } [data-redline-theme="dark"] .redline-markdown :not(pre) > code, [data-redline-theme="dark"] .redline-markdown th, [data-redline-theme="dark"] .redline-frontmatter { background: #393c42; } [data-redline-theme="dark"] .redline-markdown th, [data-redline-theme="dark"] .redline-markdown td, [data-redline-theme="dark"] .redline-frontmatter { border-color: #646a73; }
`;

function wrapDocument(fragment: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style data-redline-markdown>${MARKDOWN_STYLE}</style></head><body class="redline-markdown">${fragment}</body></html>`;
}

/**
 * Marked's default table renderer emits formatting newlines between rows and cells. Those text
 * nodes are not part of the Markdown document, but a row insertion changes their count and makes
 * the engine replace the whole tbody. Keep the same semantic table while omitting those generated
 * whitespace nodes so rows and cells remain independently alignable.
 */
function markdownRenderer(): Renderer {
  const renderer = new Renderer();
  const defaultTablecell = renderer.tablecell.bind(renderer);
  renderer.tablecell = (cell) => defaultTablecell(cell).replace(/\n$/, "");
  renderer.tablerow = ({ text }) => `<tr>${text}</tr>`;
  renderer.table = ({ header, rows }) => {
    const headerHtml = header.map((cell) => renderer.tablecell(cell)).join("");
    const rowsHtml = rows
      .map((row) => renderer.tablerow({ text: row.map((cell) => renderer.tablecell(cell)).join("") }))
      .join("");
    return `<table><thead><tr>${headerHtml}</tr></thead>${rowsHtml ? `<tbody>${rowsHtml}</tbody>` : ""}</table>`;
  };
  return renderer;
}

/** Synchronous worker-only conversion. The caller enforces cancellation by terminating its worker. */
export function renderMarkdown(source: string): string {
  if (source.length > MARKDOWN_INPUT_LIMIT) throw new MarkdownLimitError("input");
  const { metadata, body } = splitFrontmatter(source);
  const metadataFragment = metadata === null ? "" : metadataHtml(metadata);
  const rendered = marked.parse(body, {
    gfm: true,
    breaks: false,
    async: false,
    renderer: markdownRenderer(),
  });
  const html = wrapDocument(metadataFragment + rendered);
  if (html.length > MARKDOWN_OUTPUT_LIMIT) throw new MarkdownLimitError("output");
  return html;
}
