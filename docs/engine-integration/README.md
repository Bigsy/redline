# Engine integration verification

## Phase 4 — 2026-09-27

The plugin pins `redline-engine@0.2.0` exactly from npm and bundles it in the comparison
worker. The release appeared on npm during verification. Its downloaded tarball is
byte-for-byte identical to the initially tested prepared candidate (SHA-256
`d91fafb25b06a50f8786210a69ef181869430ca5cd695c579b8ed76ac6cfd761`). The final
manifest and lockfile use the registry; no local file dependency remains.

The projector captures lead ownership before changing sibling relationships, removes only an
absent element's owned whitespace, and restores the entire before attribute list. It retains
model-1 node/wrapper/unwrap behavior and supports custom prefixes. Attribute edits now have
amber outlines, navigation targets on both sides, and minimap tooltips. Tooltip values are
plain text; display titles are applied only to the displayed Redline clone so source titles
and exact attributes survive Original and Final. Unknown operation models remain rejected.

All eleven conformance vectors run directly from the installed engine package in unit tests
and in Chromium against the plugin projector. Focused fixtures cover pretty-printed lists
and tables, attribute-only wrappers with escaped values, and attribute-plus-text cells.
The original Markdown `tbody[data-diff-node]` unit expectation is unchanged. Unrelated
single-word cells now use marked `td` elements; shared notes still receive inline changes.

Reproduce with `pnpm install --frozen-lockfile`, `CI=true pnpm run typecheck`, `pnpm test`,
`pnpm run build`, `pnpm run test:e2e` and `pnpm run benchmark` from `frontend`, followed by
`./gradlew check buildPlugin` from the root. Launch the sandbox with
`JAVA_TOOL_OPTIONS=-Dide.browser.jcef.debug.port=9223` and the HTML/Markdown demo pair,
then run `node bench/jcef.mjs` and `node bench/markdown-jcef.mjs` respectively from
`frontend`. Restart the sandbox after changing plugin resources.

No new plugin release, version bump or tag was created for this integration.
Timing ceilings are advisory; exact reconstruction, operation coverage, resource limits
and worker lifecycle assertions remain mandatory.

Final checks: fresh frozen registry install and TypeScript pass; 176 frontend unit tests,
73 Chromium tests, and 36 Kotlin/platform tests pass; `./gradlew check buildPlugin` passes.
Both `jcef.mjs` and `markdown-jcef.mjs` pass against the restarted final IDEA 2024.1/JCEF 122
plugin. The HTML script additionally runs all four shared model-2 precision fixtures through
the packaged worker and checks exact bodies, attribute tooltips and navigation.

Small-corpus render-ready p95 is 93–101 ms. Large aligned/wrapped/start-insertion shapes
are 1.13–1.19 s p95; every advisory target passed. Both projections and all 120 changed
paragraphs pass the mandatory checks. Retained DOM/listener counts remain flat across
refresh and 30/60/90-switch checkpoints. These are retained-heap observations, not RSS caps.
The final registry build has byte-identical runtime JS to the benchmarked candidate; the
[package audit](package-audit.json) verifies that the ZIP, generated web assets and sandbox
JAR match and include all engine/parser/runtime notices.

The commit/push follow-up incorporates the existing remote 0.3.1 release. The XML feature
description and Unreleased changelog describe model 2; published 0.3.1 notes remain intact.
The refreshed 0.3.1 ZIP audit matches the same runtime JS exercised by the checks above.

No Phase 4 implementation or registry blocker remains. The existing manual release gates
remain: native IntelliJ Swap Sides toolbar dispatch and actual Document/VFS edit notification.
The computer-use runtime reports `CUA_REPL_ENABLED_SURFACES is required`; CDP checks exercise
the navigation bridge and injected resource refresh/swap, not those native interactions.

## Original 0.1.0 integration (historical)

The original integration pinned `redline-engine@0.1.0` from npm and bundled it in the module worker. No sibling
checkout, runtime download, selector, legacy retry, positional partition or synchronous fallback
is used. No changes to the standalone engine were necessary.

## Audit failure disposition

The unchanged titles and original results remain in `../engine-review/evidence.json`.

| Audit unit failure | Disposition and replacement evidence |
| --- | --- |
| Transaction guide TOC/table markers | Representation change: actual elements carry metadata; corpus assertions inspect all content markers. |
| Real atomic tags as single tokens | Representation change: video is the annotated element, with no nested inline marker. |
| Source fake deletion | Host bug: strip all data-diff attributes; count real inline markers separately from the untouched li. |
| Attribute-only zero markers | Intentional improvement: complete before/after replacement, navigable. |
| Added blocks reconstruction | Host bug: descendant-first insert/delete projection. |
| Removed blocks reconstruction | Host bug: symmetric projection. |
| Bare hr zero markers | Intentional improvement: actual void element is marked and projected. |
| Reindentation zero markers | Intentional improvement: exact whitespace operations retained. CSS may preserve them. |
| Preformatted zero markers | Intentional improvement: atomic pre replacement is represented. |
| Attribute changes formatting classification | Intentional improvement: nonzero markers, still not formatting-only. |
| Aligned document partitioning | Removed implementation contract: one whole-body request; all sparse edits and unchanged context checked. |
| Viewer attribute-only fallback | Intentional improvement: navigable coarse replacement notice, no incomplete-coverage warning. |
| Viewer whitespace unchanged message | Intentional improvement: marked whitespace stays in the comparison; CRLF normalizes before comparison. |
| Viewer mixed attributes incomplete warning | Intentional improvement: complete marked replacements; head changes retain their caveat. |
| Rapid reload merged text concatenation | Representation change: shared context may split an insertion phrase; assert marked content, final projection and retained scroll. |

| Audit browser failure/probe | Evidence |
| --- | --- |
| Large first insertion must contain a whole phrase | Check edited content across markers, then exact Final text; benchmark checks all 120 edited paragraphs and both DOMs. |
| Hidden stylesheet warning | Retained and adapted to projected p targets; added formatting/table cases and whole-body hiding. |
| Inserted list item in Original | Positive browser regression checks exact original body. |
| Deleted list item in Final | Positive browser regression checks exact final body. |
| Bold-only navigation | Both projected sides and visible ticks checked. |
| Reserved marker namespace | Full namespace stripped, recursively including nested templates. |

Additional deliberate changes: source `ins.redline`/`del.redline` classes now survive because
ownership depends exclusively on generated metadata. Projected text targets are native Ranges;
no navigation wrappers are inserted. Unit tests use an explicit worker mock, never a production
main-thread import. An already-aborted signal creates no executor at all.

## Reproduction

From the repository root, generate the synthetic large corpus with
`node testdata/large/generate.mjs`. From `frontend`, run `CI=true pnpm run typecheck`,
`pnpm run test`, `pnpm run build`, `pnpm run test:e2e`, then `pnpm run benchmark`.
The benchmark writes `benchmark-results.json` here, recording machine/browser, hashes,
three cold and twenty warm samples, engine stages, host stages, projection switches and
forced-GC retained-memory snapshots. Run sequentially without other benchmarks or IDE startup.
Chromium needs permission to create macOS IPC endpoints outside a restrictive filesystem sandbox.

## Resource and appearance policy

The host caps combined input at 2,000,000 UTF-16 string units and merged output at 2,000,000.
Other explicit limits are 200,000 nodes per side, depth 256, 50,000,000 engine work units and
15 seconds, with a host watchdog and cancellation. One worker is active per view and terminated
on every terminal path. One detached immutable merged body and one displayed body are retained;
side DOMs are built on demand. Input/output limits are not hard RSS ceilings.

The standalone engine's documented 7.8 MB extreme-expansion p95 failure (2.403 seconds) and
1.47–1.52 GiB laid-out browser RSS observation remain unchanged. This plugin's lower output cap
rejects such output; it does not fix or relabel that standalone limitation.

Both projections are independently validated against sanitized browser inputs, including
namespaces, attributes, empty/void nodes, template content and whitespace. Adjacent text splits
and attribute order are the only canonicalization. Browser projection mismatch is an explicit
unsupported fallback. Original and Final still use the after document's head/base policy;
styles, hidden content and duplicate IDs can affect appearance. They are body projections,
not source-byte or original-head pixel reconstructions.

## Release and rollback

Version 0.3.0 and a local commit are authorized; no publication, tag or push is authorized or performed. Roll back by reinstalling the previous
plugin/package version; there is no runtime engine selector. Packaged JCEF is a separate gate
from Chromium automation. Final check results and any outstanding gate are recorded in PLAN.md.

## Recorded final results

TypeScript, 133 unit tests, 43 Chromium tests, Gradle check and buildPlugin pass. The bundle and ZIP
hash/notice audits are in `bundle-audit.json` and `package-audit.json`. Small corpus p95 is 42–92 ms; all three large
shapes are 1.12–1.13 seconds p95. Mode-switch observations are 205–229 ms for the large inputs
(two samples per shape). Retained DOM/listener counts are stable at the sampled refresh/switch
checkpoints. JS heaps vary slightly with warmup and allocation; these observations are not RSS caps.

Actual IntelliJ 2024.1 JCEF (Chromium 122) passed the final restarted plugin smoke checks in
`jcef-results.json`; `jcef.png` shows the rendered result. To reproduce, launch `runIde` on
`testdata/jcef/before.html` and `testdata/jcef/after.html` with
`JAVA_TOOL_OPTIONS=-Dide.browser.jcef.debug.port=9223`, then run `node bench/jcef.mjs` from frontend.

**Release approval remains open for two native interactions:** clicking IntelliJ's Swap Sides
button and editing its Document to trigger the live listener. The standalone Java sandbox is not
addressable by the available computer-use app API. The packaged shell's swapped/edited resource
payload behavior and Kotlin session-update/swap tests pass, but do not establish those native UI
paths. Version 0.3.0 is prepared locally at the user’s request; no release was published and
no changes were pushed.

Scrolled-mode cleanup is covered explicitly: one pending scroll-load callback per frame is
retained, replacing the prior callback on mode changes. This avoids listener growth without
breaking late stylesheet restoration. The final 30/60/90-switch memory samples use nonzero
scroll positions for large documents; DOM and listener counts remain flat.
