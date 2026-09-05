# Third-party notices

redline-engine is MIT licensed; see LICENSE.

Runtime dependencies are installed separately by the package manager, not bundled into this
package's JavaScript:

- **parse5 8.0.1**, MIT, Ivan Nikulin and contributors. Pinned because the engine subclasses
  its parser's child-adoption operation; differential tests protect parser semantics.
- **diff (jsdiff) 9.x**, BSD-3-Clause, Kevin Decker and contributors.
- **entities**, a transitive parse5 dependency, BSD-2-Clause, Felix Böhm and contributors.

Their distributed packages retain their own full license texts. Bundlers combining dependencies
must retain the notices required by those packages; this summary does not replace those licenses.

The source repository additionally contains MIT-licensed node-htmldiff 0.9.4 upstream tests and
benchmark code (2012 Network Inc./contributors; 2022 idesis GmbH), plus the sibling Redline
project's licensed synthetic corpus. Full notices and provenance remain beside those files.
No legacy engine, copied fixture, sanitizer, browser runner or IDE dependency is included in the
published package. Development dependencies have their own licenses.
