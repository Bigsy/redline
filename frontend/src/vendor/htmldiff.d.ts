/**
 * Compares two pieces of HTML and returns the combined content with differences wrapped in
 * `<ins>` and `<del>` tags.
 *
 * @param atomicTags Comma-separated tag names treated as single tokens (children not diffed).
 *   ALWAYS pass this explicitly — see `ATOMIC_TAGS` in diff.ts.
 */
declare function diff(
  before: string,
  after: string,
  className?: string | null,
  dataPrefix?: string | null,
  atomicTags?: string | null,
): string;

export default diff;
