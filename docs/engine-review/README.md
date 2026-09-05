# Published engine replacement review

Reviewed 2026-09-05. Package: `redline-engine@0.1.0`.

## Verdict

The engine is a viable replacement and removes the measured need for the positional shortcut.
It is **not yet a drop-in replacement that passes the plugin's tests**. Adopt it through an
explicit marker/viewer integration, then remove the old matcher and shortcut together.
No production plugin or sibling-engine code was changed during this review.

## What was verified

Downloaded the exact published package into an isolated frontend copy and checked its registry
integrity against the recorded release. All 30 local build files matched the npm artifact
byte-for-byte. Redirected the engine suite's public API imports to that installed artifact;
internal parser unit tests still exercised the matching local source.

For the plugin experiment, replaced the legacy import in both worker and inline execution paths,
and redirected direct-engine regression tests to the same adapter. The adapter calls
`compareBodies`/`renderMerged`, passes the class and atomic-tag options, and throws on non-success.
Disabled the `alignedBodyChunks` call. Kept all existing assertions and viewer/marker logic intact
to expose compatibility gaps. This is deliberately a substitution probe, not completed integration.

| Check | Result |
| --- | --- |
| Engine TypeScript/build | Pass |
| Engine unit suite | 40/40 pass |
| Published-engine adapted compatibility suite, with independent Chromium projection checks | 317/317 pass; no skips |
| Original upstream tests against original legacy engine | 87/87 pass; baseline only |
| Engine Chromium/playground/15-second watchdog tests | 25/25 pass |
| Unchanged plugin unit suite | 118/118 pass |
| Unchanged plugin Chromium suite | 18/18 pass |
| Plugin with published-engine substitution, shortcut disabled | 103/118 unit tests pass; 15 fail |
| Same substitution, existing Chromium suite | 16/18 pass; 2 fail |
| Four added host-compatibility browser probes | All four expose integration failures |
| Substitution TypeScript/Vite build | Pass |

The original upstream baseline is not evidence of new-engine parity; that evidence comes from
the separately executed 317 adapted checks. Current test counts exceed some historical README
counts. Kotlin, packaging through Gradle, and actual sandbox JCEF were not tested: there is no
completed integration candidate to approve at those layers yet.

## Performance without the positional shortcut

Machine: Apple M1 Max, macOS arm64, Node 26.0.0. Actual generated 6,000-paragraph documents,
roughly 1.98 million combined UTF-16 body units, 120 edited paragraphs. Three fresh-process
engine samples and three full Chromium page loads per shape. These are observed ranges,
not p95 or universal latency guarantees.

| Input | New whole-body engine, including validation | Existing plugin shortcut + matcher | New full Chromium viewer |
| --- | --- | --- | --- |
| Original aligned pair | 482–655 ms | 466–513 ms | 955–1,019 ms |
| Both bodies enclosed in a section | 476–492 ms | 15-second cutoff; shortcut ineligible | 933–974 ms |
| Paragraph inserted at start | 462–925 ms | 15-second cutoff; shortcut ineligible | 930–939 ms |

Raw legacy matching hit the 15-second cutoff on all three shapes. New-engine runs all succeeded
with zero coarse-replacement diagnostics. Full-viewer measurements include page navigation,
fresh bundled worker startup, host parsing/validation, navigation setup, and two animation frames.
Independent browser projections preserved both original bodies in all nine viewer samples.
Body extraction/module loading are outside the Node engine timing; cutoff includes process startup.
Some Node samples overlapped other audit checks, so use the retained ranges rather than claiming
a precise speedup. Browser benchmark samples ran sequentially without another benchmark running.

The start-insertion viewer still shows a false incomplete-highlights warning from the old host
reconstructor despite correct engine projections. Speed does not resolve the integration errors.
Keep the input guard, worker deadline, cancel path, and engine work/output limits. The package's
previously recorded 2.403-second extreme-expansion result was not rerun here; these measurements
do not supersede its documented memory/expansion limitations.

## Confirmed integration blockers

1. **Structural Original/Final views are wrong.** The engine emits `data-diff-node="insert|delete"`;
   `diff.ts` CSS and reconstruction expect `ins|del`. Browser probes show an added list item
   remains visible in Original and a deleted list item remains visible in Final.

2. **The minimap misclassifies insertions and loses a truthfulness warning.**
   `minimap.ts:measureMarkers` considers only the literal `ins` value an insertion. New inline
   wrappers also carry `data-diff-node="insert"`, so this affects text edits as well as blocks.
   The existing browser test “a reviewed stylesheet cannot empty a view mode in silence” fails:
   all insertions can be hidden in Final without the required warning.

3. **Formatting-only changes are missed by navigation.** The engine represents formatting shells
   with `data-diff-unwrap="before|after"`, which has no `data-diff-node`. Existing marker selectors
   ignore it. `<p>hello world</p>` → `<p>hello <b>world</b></p>` falls back instead of exposing
   a navigable formatting change. Shell unwrapping requires actual projection semantics;
   changing `insert` to `ins` alone is insufficient.

4. **The sanitizer does not cover the new reserved namespace.** It strips the old two engine
   attributes, but leaves `data-diff-op`, `data-diff-wrapper`, `data-diff-unwrap`, and other
   `data-diff-*` attributes. The new engine correctly rejects such input. A browser probe with
   an ordinary reviewed `data-diff-op` attribute therefore fails to produce a comparison.
   Define a host policy for the whole namespace, including template contents.

5. **Old reconstruction creates false warnings.** It ignores the new direction values and shell
   semantics, and leaves new metadata behind. Added/removed blocks and valid attribute replacements
   are consequently reported as incomplete. Use owned metadata to project both sides; do not
   silence the warning by hardcoding success or further weakening normalization.

## Test expectation changes versus actual regressions

Several failures intentionally encode old engine limitations: attributes, preformatted whitespace,
and bare `<hr>` changes were expected to have no markers. The replacement represents them.
Other assertions require inline wrappers around atomic/structural changes, a whole phrase in the
first `ins`, or a particular concatenation of merged text. Those are not the new engine's contract.

For example, the large Chromium test fails because the first insertion contains `Th`, not the
whole phrase “has been edited”; the comparison finishes quickly and both complete sides reconstruct.
Update such assertions to cover all marked content plus unchanged context and both projections,
while retaining deliberate visual/readability checks. Do not turn the four host defects above
into expected behavior simply to make tests green.

The full list of unchanged failing test titles and measured samples is in [evidence.json](evidence.json).
The second existing Chromium failure is the hidden-content warning described above.

## Recommended implementation sequence

1. Add the exact npm dependency and a shared typed worker request/result protocol. Preserve
   structured `limit`/`unsupported`/coarse diagnostics for appropriate UI messages.
2. Centralize owned-marker recognition, direction, operation IDs, formatting shells, and projection.
   Update CSS, marker counting, minimap grouping/directions, visibility checks, and reconstruction
   together. Recognize original `ins`/`del` separately from generated wrappers.
3. Implement Original/Final with correctly projected DOMs or separately sanitized source views;
   CSS hiding alone cannot remove side-specific formatting shells. Preserve scroll, navigation,
   find behavior, and the documented after-head appearance policy.
4. Sanitize the chosen engine namespace completely and test spoofed attributes inside templates.
   Keep the sandbox/CSP boundary. Handle worker construction failure explicitly instead of running
   an uninterruptible production comparison on the main thread.
5. Replace legacy assertions only where behavior intentionally improves or marker grouping changes.
   Add the four reproduced browser cases, hidden-content checks for both marker kinds, formatting
   projections, and structured-limit/cancel/refresh tests. Check both reconstructed sides.
6. Remove `alignedBodyChunks`, chunk request plumbing, and vendored runtime code. This also avoids
   resetting operation IDs across separately compared chunks. Keep any legacy baseline test-only.
7. Repeat frontend suites and these three benchmarks, then run Gradle checks/buildPlugin and
   restart `runIde` for actual packaged JCEF testing before releasing.

The temporary substitution bundles the engine in both the worker (185 KB) and shell (207 KB),
because the existing production inline fallback remains. The baseline worker/shell are roughly
10/30 KB. Removing that fallback during integration avoids bundling the engine twice unnecessarily.

## Reproduction notes

Temporary experiment: `/tmp/redline-audit-_5pcfj7c`, with `engine/`, `plugin/`, and `baseline/`.
Only `docs/engine-review/` is added to the real plugin checkout. The sibling project is untouched.

- Engine scripts: `typecheck`, `build`, `test`, `test:compatibility`, `test:upstream`, `test:browser`.
- Plugin tests: `vitest run` and `playwright test` after a Vite build, on baseline and substitution.
- Large Node comparison: copied `bench/sibling.mjs`, public artifact import, `PLUGIN_ROOT` pointing
  at the temporary plugin. This extracts the unchanged legacy shortcut implementation for comparison.
- Temporary `e2e/audit.spec.ts` contains the four positive host expectations that currently fail.
- Temporary `e2e/audit-benchmark.spec.ts` measures the full viewer and independently projects both
  sides from browser-parsed merged HTML. Raw reports remain in the temporary experiment; summary
  evidence and every benchmark sample are retained here.

Used direct Node invocations of local Vitest/Playwright/Vite executables after installation to avoid
pnpm's automatic dependency reinstall in the temporary copies. Browser tests required execution
outside the filesystem sandbox so Chromium could create its local macOS IPC endpoints.
