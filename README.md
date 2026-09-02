# Redline — Rendered HTML Diff for IntelliJ

[![build](https://github.com/Bigsy/redline/actions/workflows/build.yml/badge.svg)](https://github.com/Bigsy/redline/actions/workflows/build.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

https://plugins.jetbrains.com/plugin/33487-redline--rendered-html-diff

Review HTML changes as a **rendered document**, not markup. When both sides of a diff are
HTML, Redline adds a viewer that shows the page as the browser renders it, with insertions
and deletions highlighted inline — the way legal and publishing workflows mark up drafts.

![A text diff of an HTML change next to the same change rendered by Redline](assets/marketplace/01-comparison-hero.png)

Prose edits buried in long hand-authored lines, renumbered lists, and table changes become
readable at a glance instead of a wall of rewrapped markup.

## Features

- **Inline redline rendering** — one merged document with `ins`/`del` styling: deletions
  struck through in red, insertions highlighted in green, in the document's own layout.
- **Works anywhere the IDE shows a diff** — Compare Files, Local Changes, commits, and
  VCS revision history. Select **Redline** in the diff editor's viewer switcher, next to
  Side-by-side and Unified.
- **Change navigation** — previous/next change actions in the toolbar plus a minimap strip
  that marks every change block in the document, a "3 / 12" counter, and the current block
  outlined where it sits in the page.
- **Original / Redline / Final** — three views of the same merged document: the version you
  started from, the marked-up comparison, or the version you would end with. Keys `1`/`2`/`3`.
- **Find in document** — Cmd/Ctrl+F searches the rendered document, with match counts and
  match-case. Matches are found across the redline's own markup, so a phrase you can read is
  found even where an edit splits it in the HTML.
- **Live refresh** — edit the file in the editor and the redline follows, without losing your
  scroll position.
- **Swap Sides** — flip which revision counts as "before" without leaving the viewer.
- **Untrusted-by-design rendering** — reviewed documents run in a sandboxed JCEF pane:
  scripts never execute, external subresources are blocked by a strict CSP, `meta refresh`
  is stripped, and `javascript:` links are dead. Diffing a document can't phone home.

## Installation

Requires an IntelliJ Platform IDE **2024.1 or newer** with JCEF available (bundled in all
JetBrains IDEs; on 2026.2+ it lives in the bundled *Web Browser (JCEF)* plugin, which
Redline picks up automatically).

Install from inside the IDE: **Settings → Plugins → Marketplace**, search for
**Redline**, and click *Install*. (Or open the
[Marketplace listing](https://plugins.jetbrains.com/plugin/33487-redline--rendered-html-diff)
and use *Install to IDE*.)

**From source.** To run an unreleased build, build the zip yourself:

```
./gradlew buildPlugin
```

then **Settings → Plugins → ⚙ → Install Plugin from Disk…** and pick the zip from
`build/distributions/`.

## Try it

```
./gradlew runIde --args="diff testdata/demo/before.html testdata/demo/after.html"
```

opens the sandbox IDE directly on a contract-style demo diff in the Redline viewer.

## How it works

Redline registers a `FrameDiffTool` that appears in the diff viewer switcher when both
sides of the request are HTML and JCEF is available. The Kotlin side serves the viewer
shell and both documents over a custom scheme handler; the shell (a Vite + TypeScript app
in `frontend/`, bundled into `src/main/resources/web/` at build time) computes the merged
redline with [node-htmldiff](https://www.npmjs.com/package/node-htmldiff) (MIT) and renders
it into a sandboxed iframe.

The comparison itself runs in a Web Worker, so the pane stays responsive on large documents;
if it outruns its 15-second budget (or the pair is over 2 MB) Redline shows the new version
with a banner instead of freezing, and you can cancel a slow comparison while it runs.

When a side of the diff is a live document, edits to it are pushed into the open session and the
shell re-renders in place — no page reload, so your scroll position survives.

Find is shell-side rather than JCEF's native find: matches are located by walking the document's
text and painted with the CSS Custom Highlight API, which marks text without touching the DOM.
That works wherever keyboard focus happens to be, and gives match counts, which the platform's
JCEF build cannot.

## Development

```
./gradlew check          # Kotlin/platform tests (builds and tests the frontend first)
./gradlew runIde         # sandbox IDE for manual testing

cd frontend
pnpm run test            # viewer unit tests (happy-dom)
pnpm exec playwright install chromium
pnpm run test:e2e        # sandbox-enforcement proofs in real Chromium
```

Release history is in [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE)
