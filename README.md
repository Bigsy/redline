# Redline — Rendered HTML Diff

An IntelliJ Platform plugin that shows HTML diffs as a **rendered redline**: one merged document
with insertions and deletions highlighted inline, the way legal and publishing workflows mark up
drafts — instead of a wall of rewrapped markup in a text diff.

When both sides of a diff are HTML, a **Redline** option appears in the diff editor's viewer
switcher (next to Side-by-side and Unified), rendering the document in a JCEF pane.

Status: walking skeleton. See [PLAN.md](PLAN.md) for the roadmap.

## Building

```
./gradlew buildPlugin    # full plugin zip (builds the frontend via pnpm first)
./gradlew runIde         # sandbox IDE for manual testing
```

The viewer frontend is a Vite + TypeScript app in `frontend/`, bundled into
`src/main/resources/web/` at build time. The diff engine is
[node-htmldiff](https://www.npmjs.com/package/node-htmldiff) (MIT), running in the page.
