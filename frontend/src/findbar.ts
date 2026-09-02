/**
 * In-pane find for the reviewed document.
 *
 * The UI, the keyboard entry points and the match counting follow the find bar in the sibling
 * `milkj` plugin, which has the same problem (a JCEF pane the IDE's Find cannot reach). What could
 * not come across is the matching itself: milkj searches a ProseMirror document and gets match
 * decorations from `prosemirror-search`, while Redline has no editor model — just rendered HTML in
 * a sandboxed iframe. So matches are found by walking the frame's text nodes and painted with the
 * CSS Custom Highlight API, which marks text without touching the DOM (Chromium ≥ 105; the pane
 * targets 120).
 *
 * The bar itself lives on `document.body`, OUTSIDE `#app` — a re-render replaces `#app`'s
 * children (viewer.ts#render), and the bar has to survive that, exactly as milkj's survives a
 * Crepe rebuild. It is shell chrome, so the reviewed document's CSS cannot reach it, and the
 * frame's own scripts never run to see it.
 *
 * Native `CefBrowser.find()` was the other option (PLAN.md batch E). This route was taken because
 * it works regardless of where Swing focus sits, needs no Kotlin at all, gives match counts (the
 * 2024.1 JCEF has no `CefFindHandler`, so native find cannot), and is testable in Playwright.
 */

/** Highlight registry names. Two, so the current match can be picked out from the rest. */
const HIGHLIGHT_ALL = "redline-find";
const HIGHLIGHT_CURRENT = "redline-find-current";

/**
 * Styling for the two highlights, injected into whichever document the frame is showing.
 *
 * Injected rather than living in `REDLINE_CSS` because find has to work in the states that do NOT
 * get the merged redline: "too large", "no changes" and the failure fallbacks all point the frame
 * at the raw document, which never passes through `assembleRedline`. One definition, applied
 * wherever the frame lands, beats the same rules in two places drifting apart.
 *
 * `!important` for the same reason the marker CSS uses it (PLAN.md decision #6): a reviewed
 * stylesheet must not be able to make the reader's search results invisible.
 */
const FIND_CSS = `
  ::highlight(${HIGHLIGHT_ALL}) { background: #ffe89a !important; color: #1a1a1a !important; }
  ::highlight(${HIGHLIGHT_CURRENT}) { background: #ff9d0a !important; color: #1a1a1a !important; }
`;

const FIND_STYLE_ID = "redline-find-style";

/**
 * Cap on matches per query. The document is rescanned on every keystroke, so a one-letter query
 * on a long document must not be allowed to build a hundred thousand Ranges.
 */
const MAX_MATCHES = 2000;

/** Text-node content Redline must not offer as a search hit. */
const NON_TEXT_PARENTS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "TITLE"]);

function isSpace(ch: string): boolean {
  return ch === " " || ch === "\n" || ch === "\t" || ch === "\r" || ch === "\f" || ch === " ";
}

/**
 * The slice of the frame's realm that painting needs. Spelled out rather than taken from the DOM
 * lib because `Window.Highlight` is not in it, and because every part is genuinely optional: the
 * API is absent in happy-dom and in any Chromium below 105, where find still counts and scrolls
 * and simply cannot colour anything.
 */
interface HighlightRealm {
  CSS?: { highlights?: { set(name: string, highlight: object): void; delete(name: string): void } };
  Highlight?: new (...ranges: Range[]) => object;
}

/** One text node's contribution to the haystack, at `start`. Contiguous and 1:1 with the node. */
interface TextPiece {
  node: Text;
  start: number;
}

interface DocumentText {
  haystack: string;
  pieces: TextPiece[];
}

/**
 * The document's text with node boundaries recorded, so a match can be turned back into a Range.
 *
 * Deliberately 1:1 with the source text — no whitespace collapsing — so the mapping back is a
 * binary search rather than a per-character table. Source whitespace that the renderer collapses
 * is handled by the matcher instead (see [matchAt]).
 */
export function documentText(root: Node): DocumentText {
  const doc = root.ownerDocument ?? (root as Document);
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      NON_TEXT_PARENTS.has((node.parentElement?.tagName ?? "").toUpperCase())
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });

  const pieces: TextPiece[] = [];
  let haystack = "";
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue ?? "";
    if (text.length === 0) continue;
    pieces.push({ node: node as Text, start: haystack.length });
    haystack += text;
  }
  return { haystack, pieces };
}

/**
 * Does `needle` match `haystack` at `at`? Returns the end index (exclusive), or -1.
 *
 * Any run of whitespace matches any other run, so a query typed as one line still finds text the
 * source happens to wrap or indent — searching a rendered document, the reader is matching what
 * they can see, not the markup's line breaks.
 */
function matchAt(haystack: string, needle: string, at: number, caseSensitive: boolean): number {
  let h = at;
  let n = 0;
  while (n < needle.length) {
    if (isSpace(needle[n])) {
      if (h >= haystack.length || !isSpace(haystack[h])) return -1;
      while (h < haystack.length && isSpace(haystack[h])) h++;
      while (n < needle.length && isSpace(needle[n])) n++;
      continue;
    }
    if (h >= haystack.length) return -1;
    const a = caseSensitive ? haystack[h] : haystack[h].toLowerCase();
    const b = caseSensitive ? needle[n] : needle[n].toLowerCase();
    if (a !== b) return -1;
    h++;
    n++;
  }
  return h;
}

/**
 * Turn a haystack index back into a (node, offset) pair.
 *
 * `atEnd` decides who owns an index that falls exactly on a node boundary. For a match's END it
 * is the piece that FINISHES there, not the one that begins there: `setEnd(nextNode, 0)` stretches
 * the Range into the following element, which paints a highlight across text that is not a match
 * and — worse — lets a match borrow a client rect from its neighbour. In a redline the neighbour
 * is usually the opposite marker (`<del>removed</del><ins>inserted</ins>`), so a deletion hidden
 * by `final` mode would measure as visible and be offered to the reader anyway.
 */
function locate(pieces: TextPiece[], index: number, atEnd = false): { node: Text; offset: number } | null {
  if (pieces.length === 0) return null;
  let low = 0;
  let high = pieces.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (pieces[mid].start <= index) low = mid;
    else high = mid - 1;
  }
  if (atEnd && low > 0 && pieces[low].start === index) low -= 1;
  const piece = pieces[low];
  const length = piece.node.nodeValue?.length ?? 0;
  return { node: piece.node, offset: Math.min(index - piece.start, length) };
}

/**
 * Every match for `query` under `root`, as Ranges in document order.
 *
 * Matches may span text nodes, which here is the common case rather than an edge case: the redline
 * splits text at every change (`the <del>quick</del><ins>slow</ins> brown fox`), so a phrase the
 * reader can see is frequently three nodes in the DOM. Non-overlapping, like every find.
 */
export function findRanges(
  root: Element,
  query: string,
  caseSensitive = false,
  limit = MAX_MATCHES,
): Range[] {
  if (query === "") return [];
  const { haystack, pieces } = documentText(root);
  const doc = root.ownerDocument!;
  const ranges: Range[] = [];

  for (let i = 0; i < haystack.length && ranges.length < limit; ) {
    const end = matchAt(haystack, query, i, caseSensitive);
    if (end === -1) {
      i++;
      continue;
    }
    const from = locate(pieces, i);
    const to = locate(pieces, end, true);
    if (from && to) {
      const range = doc.createRange();
      range.setStart(from.node, from.offset);
      range.setEnd(to.node, to.offset);
      ranges.push(range);
    }
    // A zero-length match would never advance; guard so a whitespace-only query terminates.
    i = end > i ? end : i + 1;
  }
  return ranges;
}

/**
 * Drop matches with no box: text hidden by the reviewed document's own CSS, and — the reason this
 * matters — the side the current view mode hides (`original`/`final`). Offering the reader a hit
 * they cannot see, and cannot scroll to, would be worse than not finding it.
 *
 * Skipped when the document has no layout at all (not laid out yet, or a layout-less test DOM):
 * there every match measures zero and this would drop the lot. Same rule the minimap measures by.
 */
function visibleOnly(doc: Document, ranges: Range[]): Range[] {
  if (doc.documentElement.getBoundingClientRect().height <= 0) return ranges;
  return ranges.filter((range) => range.getClientRects().length > 0);
}

export interface FindBar {
  /**
   * Point the bar at the frame a render just produced: inject the highlight CSS, move the
   * in-frame key listener, and re-run the active query against the new document.
   */
  attach(frame: HTMLIFrameElement | null): void;
  /** Re-run the active query in place — the document or the view mode changed under us. */
  refresh(): void;
  dispose(): void;
}

export function installFindBar(): FindBar {
  let frame: HTMLIFrameElement | null = null;
  let boundDoc: Document | null = null;
  let open = false;
  let caseSensitive = false;
  let matches: Range[] = [];
  let current = -1;

  const bar = document.createElement("div");
  bar.className = "redline-findbar";
  bar.hidden = true;
  bar.innerHTML = `
    <input class="redline-findbar-search" type="text" placeholder="Find in document" spellcheck="false">
    <button type="button" class="redline-findbar-case" title="Match case" aria-pressed="false">Aa</button>
    <span class="redline-findbar-count"></span>
    <button type="button" class="redline-findbar-prev" title="Previous match (Shift+Enter)">&#8593;</button>
    <button type="button" class="redline-findbar-next" title="Next match (Enter)">&#8595;</button>
    <button type="button" class="redline-findbar-close" title="Close (Escape)">&#10005;</button>
  `;

  const searchInput = bar.querySelector<HTMLInputElement>(".redline-findbar-search")!;
  const caseButton = bar.querySelector<HTMLButtonElement>(".redline-findbar-case")!;
  const countLabel = bar.querySelector<HTMLSpanElement>(".redline-findbar-count")!;

  function frameDoc(): Document | null {
    return frame?.contentDocument ?? null;
  }

  /** Idempotent: the same frame is attached once per render, and re-renders reuse nothing. */
  function injectCss(doc: Document): void {
    if (doc.getElementById(FIND_STYLE_ID)) return;
    const style = doc.createElement("style");
    style.id = FIND_STYLE_ID;
    style.textContent = FIND_CSS;
    (doc.head ?? doc.documentElement)?.appendChild(style);
  }

  function paint(): void {
    // The registry belongs to the frame's realm, so its Highlight constructor is the one to use.
    const realm = frame?.contentWindow as unknown as HighlightRealm | undefined;
    const highlights = realm?.CSS?.highlights;
    const Highlight = realm?.Highlight;
    if (!highlights || typeof Highlight !== "function") return;
    highlights.delete(HIGHLIGHT_ALL);
    highlights.delete(HIGHLIGHT_CURRENT);
    if (matches.length === 0) return;
    highlights.set(HIGHLIGHT_ALL, new Highlight(...matches));
    if (current >= 0) highlights.set(HIGHLIGHT_CURRENT, new Highlight(matches[current]));
  }

  function updateCount(): void {
    const query = searchInput.value;
    if (query === "") {
      countLabel.textContent = "";
      countLabel.classList.remove("redline-findbar-no-results");
      return;
    }
    const total = matches.length;
    countLabel.textContent =
      total === 0 ? "No results" : current >= 0 ? `${current + 1}/${total}` : `${total}`;
    countLabel.classList.toggle("redline-findbar-no-results", total === 0);
  }

  /** Rescan the document for the current query. Called on every keystroke — cheap enough. */
  function search(keepCurrent = false): void {
    const doc = frameDoc();
    const query = searchInput.value;
    const previous = current;
    matches = doc && query !== "" ? visibleOnly(doc, findRanges(doc.body, query, caseSensitive)) : [];
    current = keepCurrent && previous >= 0 && previous < matches.length ? previous : -1;
    paint();
    updateCount();
  }

  function goTo(index: number): void {
    if (matches.length === 0) return;
    current = ((index % matches.length) + matches.length) % matches.length;
    const win = frame?.contentWindow;
    const rect = matches[current].getBoundingClientRect();
    // Centre the MATCH, not its paragraph: in a long block the paragraph's top tells the reader
    // nothing about where the hit is.
    if (win && (rect.height > 0 || rect.width > 0)) {
      win.scrollTo({ top: Math.max(win.scrollY + rect.top - win.innerHeight / 2, 0), behavior: "smooth" });
    }
    paint();
    updateCount();
  }

  function openBar(): void {
    open = true;
    bar.hidden = false;
    search();
    searchInput.focus();
    searchInput.select();
  }

  function closeBar(): void {
    open = false;
    bar.hidden = true;
    matches = [];
    current = -1;
    paint();
    updateCount();
  }

  searchInput.addEventListener("input", () => search());
  searchInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      goTo(event.shiftKey ? current - 1 : current + 1);
    }
  });

  caseButton.addEventListener("click", () => {
    caseSensitive = !caseSensitive;
    caseButton.setAttribute("aria-pressed", String(caseSensitive));
    search();
    searchInput.focus();
  });
  bar.querySelector(".redline-findbar-prev")!.addEventListener("click", () => goTo(current - 1));
  bar.querySelector(".redline-findbar-next")!.addEventListener("click", () => goTo(current + 1));
  bar.querySelector(".redline-findbar-close")!.addEventListener("click", () => {
    closeBar();
    frame?.contentWindow?.focus();
  });

  // Keep focus in the input when a bar button is clicked, so Enter keeps cycling matches.
  for (const button of bar.querySelectorAll("button")) {
    button.addEventListener("mousedown", (event) => event.preventDefault());
  }

  /**
   * Capture phase, so the shortcuts win before anything else reads the key. Bound to the shell
   * window AND to the framed document: focus sits in the frame after the reader clicks the
   * document, and events there do not reach the shell's window.
   */
  const onKey = (event: KeyboardEvent): void => {
    const mod = event.metaKey || event.ctrlKey;
    if (mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "f") {
      event.preventDefault();
      openBar();
      return;
    }
    if (!open) return;
    if ((mod && event.key.toLowerCase() === "g") || event.key === "F3") {
      event.preventDefault();
      goTo(event.shiftKey ? current - 1 : current + 1);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeBar();
      frame?.contentWindow?.focus();
    }
  };
  window.addEventListener("keydown", onKey, { capture: true });

  document.body.append(bar);

  return {
    attach(next) {
      boundDoc?.removeEventListener("keydown", onKey, { capture: true });
      boundDoc = null;
      frame = next;
      const doc = frameDoc();
      if (doc) {
        injectCss(doc);
        doc.addEventListener("keydown", onKey, { capture: true });
        boundDoc = doc;
      }
      // The old document's matches are gone with it; re-find in the new one, keeping the
      // reader's position in the result list where it still exists.
      if (open) search(true);
    },
    refresh() {
      if (open) search(true);
    },
    dispose() {
      window.removeEventListener("keydown", onKey, { capture: true });
      boundDoc?.removeEventListener("keydown", onKey, { capture: true });
      boundDoc = null;
      matches = [];
      current = -1;
      paint();
      bar.remove();
    },
  };
}
