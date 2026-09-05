# Changelog

All notable changes to Redline are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] — 2026-09-05

### Changed

- Replace the vendored matcher and aligned-sibling shortcut with the exact published
  `redline-engine@0.1.0`, bundled only in a whole-body worker. No synchronous fallback or retry.
- Original and Final now project structural and formatting changes correctly. Navigation,
  minimap and find use retained elements and text ranges across mode changes.
- Attribute, void-element and preformatted changes are marked; whitespace is preserved.
  Regions compared as complete replacements show a reduced-precision notice: all content is
  retained, but individual word edits within those regions are not identified. Both browser projections
  must preserve sanitized inputs or the viewer explicitly falls back.
- Reserve and sanitize the complete engine metadata namespace, including nested templates.
  Source ins/del classes remain ordinary content. Keep the after-head/base appearance policy.
- Cap merged output at 2,000,000 UTF-16 units in addition to the existing input guard,
  worker watchdog and cancellation. Package runtime dependency license notices.

### Fixed

- Preserve scroll restoration when stylesheets load late, and prevent pending scroll listeners
  from accumulating across view-mode switches.
- Remeasure change markers after stylesheets load so navigation and the minimap stay aligned.

## [0.2.0] — 2026-09-03

### Added

- Large documents no longer freeze the viewer. The comparison runs in a Web Worker with a
  15-second budget and a Cancel button; documents that outrun it (or exceed 2 MB across both
  sides) show the new version with a banner pointing at the text diff, instead of an
  unresponsive pane with no way out.
- The viewer chrome now follows the IDE theme live: switching look-and-feel with a Redline diff
  open re-themes the pane instead of waiting for it to be reopened.
- **Find in document** (Cmd/Ctrl+F), with match counts, match-case, Enter/Shift+Enter to walk
  matches and Escape to clear. The IDE's own Find cannot reach inside the rendered pane. Matches
  span the redline's markup, so searching for a phrase finds it even where an edit splits it in
  two, and matches hidden by the current view mode are skipped rather than scrolled to.
- **Original / Redline / Final view modes.** A segmented control in the pane (or the keys
  `1`/`2`/`3`) switches between the document you started from, the marked-up comparison, and the
  document you would end with — all from the one merged render, so switching is instant.
- A change counter ("3 / 12") next to the navigation buttons, and the change block you are
  currently on is outlined in the document itself rather than only on the minimap strip.
- The redline now follows the file as you edit it. In a Local Changes or editor diff the after
  side is the live document; Redline re-renders shortly after you stop typing, keeping your place
  in the document instead of showing the file as it was when the pane opened.

### Changed

- Large, structurally stable documents with sparse edits render much faster by passing unchanged
  sibling blocks through and diffing only the edited blocks; the synthetic ~970 KB-per-side test
  corpus now completes within the normal 15-second budget.
- Whitespace- and line-ending-only edits are called out as such ("Only whitespace or line endings
  differ — the rendered document is unchanged") instead of the misleading "not visible in rendered
  form … use the text diff" warning.
- Installing or updating Redline now asks for an IDE restart. The viewer registers a scheme
  handler with JCEF, which offers no way to withdraw a single handler, so a hot swap would leave
  the previous version's handler (and its classloader) behind.
- More document assets are served with a correct content type (`ico`, `json`, `ttf`, `otf`, `xml`,
  `avif`, `bmp`, `txt`, `htm`/`xhtml`, `mjs`), and extensions are matched case-insensitively.

## [0.1.0] — 2026-08-11

Initial release.

### Added

- **Redline viewer** in the diff editor's view switcher whenever both sides of a diff are HTML:
  one rendered document with deletions struck through and insertions highlighted inline, in the
  document's own layout.
- Works anywhere the IDE shows a diff — Compare Files, Local Changes, commits, and VCS revision
  history.
- Previous/next change navigation, plus a minimap strip marking every change block in the
  document.
- **Swap Sides** action to flip which revision counts as "before".
- Untrusted-by-design rendering: reviewed documents load in a sandboxed JCEF pane where scripts
  never execute, external subresources are blocked by a strict CSP, `meta refresh` is stripped,
  and `javascript:` links are inert — so diffing a document cannot phone home.
- Compatible with IntelliJ Platform 2024.1 and newer, including 2026.2+ where JCEF ships as the
  separate bundled *Web Browser (JCEF)* plugin.

[Unreleased]: https://github.com/Bigsy/redline/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/Bigsy/redline/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Bigsy/redline/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Bigsy/redline/releases/tag/v0.1.0
