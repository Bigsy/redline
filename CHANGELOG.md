# Changelog

All notable changes to Redline are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Large documents no longer freeze the viewer. The comparison runs in a Web Worker with a
  15-second budget and a Cancel button; documents that outrun it (or exceed 2 MB across both
  sides) show the new version with a banner pointing at the text diff, instead of an
  unresponsive pane with no way out.
- The viewer chrome now follows the IDE theme live: switching look-and-feel with a Redline diff
  open re-themes the pane instead of waiting for it to be reopened.

### Changed

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

[Unreleased]: https://github.com/Bigsy/redline/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Bigsy/redline/releases/tag/v0.1.0
