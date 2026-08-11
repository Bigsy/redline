# Changelog

All notable changes to Redline are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
