import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { findRanges, installFindBar, type FindBar } from "./findbar";

/**
 * The matching core, plus the bar's state machine. What happy-dom cannot show is the painting —
 * the CSS Custom Highlight API does not exist here, and it exposes nothing to JS even where it
 * does; `e2e/sandbox.spec.ts` proves that part by screenshot in real Chromium.
 */

/**
 * A frame holding a reviewed document, replacing `#app`'s children exactly as viewer.ts#render
 * does — and, like it, leaving the rest of `document.body` alone. That is where the find bar
 * lives, precisely so a re-render cannot take it away.
 */
function reviewed(body: string): { doc: Document; frame: HTMLIFrameElement } {
  let app = document.getElementById("app");
  if (!app) {
    app = document.createElement("div");
    app.id = "app";
    document.body.appendChild(app);
  }
  app.replaceChildren();
  const frame = document.createElement("iframe");
  app.appendChild(frame);
  const doc = frame.contentDocument!;
  doc.body.innerHTML = body;
  return { doc, frame };
}

const texts = (ranges: Range[]) => ranges.map((r) => r.toString());

describe("findRanges", () => {
  it("finds every occurrence, case-insensitively by default", () => {
    const { doc } = reviewed("<p>Beta and beta and BETA</p>");
    expect(texts(findRanges(doc.body, "beta"))).toEqual(["Beta", "beta", "BETA"]);
  });

  it("respects match case when asked", () => {
    const { doc } = reviewed("<p>Beta and beta and BETA</p>");
    expect(texts(findRanges(doc.body, "beta", true))).toEqual(["beta"]);
  });

  it("returns nothing for an empty query", () => {
    const { doc } = reviewed("<p>anything</p>");
    expect(findRanges(doc.body, "")).toEqual([]);
  });

  it("does not overlap matches", () => {
    const { doc } = reviewed("<p>aaaa</p>");
    expect(texts(findRanges(doc.body, "aa"))).toEqual(["aa", "aa"]);
  });

  it("matches across the text nodes a redline splits text into", () => {
    // The engine's own output shape. A per-text-node search would miss this, and in a redline it
    // is the common case, not an edge case — every change splits the sentence around it.
    const { doc } = reviewed('<p>the <del class="redline">quick</del><ins class="redline">slow</ins> brown fox</p>');
    const found = findRanges(doc.body, "slow brown");
    expect(texts(found)).toEqual(["slow brown"]);
    // …and the Range really does span two nodes, which is what lets the browser paint it.
    expect(found[0].startContainer).not.toBe(found[0].endContainer);
  });

  it("ends a match in the node it finishes in, not at the start of the next", () => {
    const { doc } = reviewed('<p>the <del class="redline">removed</del><ins class="redline">inserted</ins> clause</p>');
    const [range] = findRanges(doc.body, "removed");
    // Ending at offset 0 of the <ins> reads as the same text but is a different Range: it paints
    // across the insertion, and lends the deletion a client rect it should not have — which is
    // what makes a hit hidden by `final` mode look reachable.
    expect(range.endContainer).toBe(range.startContainer);
    expect(range.endContainer.parentElement?.tagName).toBe("DEL");
    expect(range.endOffset).toBe("removed".length);
  });

  it("treats any run of whitespace as equivalent, so source wrapping does not hide a phrase", () => {
    const { doc } = reviewed("<p>brown\n        fox</p>");
    expect(texts(findRanges(doc.body, "brown fox"))).toHaveLength(1);
  });

  it("ignores text that is not content", () => {
    const { doc } = reviewed("<style>p { color: beta }</style><p>beta</p><noscript>beta</noscript>");
    expect(findRanges(doc.body, "beta")).toHaveLength(1);
  });

  it("stops at the match limit rather than building a Range per character", () => {
    const { doc } = reviewed(`<p>${"beta ".repeat(500)}</p>`);
    expect(findRanges(doc.body, "beta", false, 10)).toHaveLength(10);
  });

  it("terminates on a whitespace-only query", () => {
    const { doc } = reviewed("<p>a b c d</p>");
    // A zero-width match would loop forever without the advance guard.
    expect(findRanges(doc.body, " ").length).toBeGreaterThan(0);
  });
});

describe("find bar", () => {
  let bar: FindBar;

  const el = <T extends Element>(selector: string): T => document.querySelector<T>(selector)!;
  const count = () => el(".redline-findbar-count").textContent;
  const hidden = () => el(".redline-findbar").hasAttribute("hidden");

  function type(query: string): void {
    const input = el<HTMLInputElement>(".redline-findbar-search");
    input.value = query;
    input.dispatchEvent(new Event("input"));
  }

  function press(key: string, init: KeyboardEventInit = {}): void {
    el(".redline-findbar-search").dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }),
    );
  }

  function openWith(body: string): void {
    const { frame } = reviewed(body);
    bar = installFindBar();
    bar.attach(frame);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, cancelable: true }));
  }

  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    bar?.dispose();
  });

  it("opens on Ctrl/Cmd+F and stays hidden until then", () => {
    const { frame } = reviewed("<p>alpha beta</p>");
    bar = installFindBar();
    bar.attach(frame);
    expect(hidden()).toBe(true);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", metaKey: true, cancelable: true }));
    expect(hidden()).toBe(false);
  });

  it("counts matches as the query is typed", () => {
    openWith("<p>beta beta beta</p>");
    expect(count()).toBe("");
    type("beta");
    expect(count()).toBe("3");
    type("beta beta");
    expect(count()).toBe("1");
  });

  it("says so when there is nothing to find", () => {
    openWith("<p>alpha</p>");
    type("beta");
    expect(count()).toBe("No results");
    expect(el(".redline-findbar-count").classList.contains("redline-findbar-no-results")).toBe(true);
  });

  it("Enter walks the matches and wraps; Shift+Enter walks back", () => {
    openWith("<p>beta beta beta</p>");
    type("beta");
    press("Enter");
    expect(count()).toBe("1/3");
    press("Enter");
    expect(count()).toBe("2/3");
    press("Enter");
    expect(count()).toBe("3/3");
    press("Enter");
    expect(count()).toBe("1/3"); // wraps
    press("Enter", { shiftKey: true });
    expect(count()).toBe("3/3");
  });

  it("the case toggle re-runs the search", () => {
    openWith("<p>Beta and beta</p>");
    type("beta");
    expect(count()).toBe("2");
    el<HTMLButtonElement>(".redline-findbar-case").click();
    expect(el(".redline-findbar-case").getAttribute("aria-pressed")).toBe("true");
    expect(count()).toBe("1");
  });

  it("Escape closes the bar, and reopening re-finds the last query", () => {
    openWith("<p>beta beta</p>");
    type("beta");
    expect(count()).toBe("2");

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    expect(hidden()).toBe(true);

    // Reopening keeps the query, like every editor's find — and re-runs it, so the count is the
    // new document's, not the one from before the document changed under us.
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, cancelable: true }));
    expect(hidden()).toBe(false);
    expect(count()).toBe("2");
  });

  it("re-finds in the new document after a live refresh, keeping the reader's place", () => {
    openWith("<p>beta beta beta</p>");
    type("beta");
    press("Enter");
    press("Enter");
    expect(count()).toBe("2/3");

    // What viewer.ts#render does: a brand-new frame with the edited document.
    const { frame } = reviewed("<p>beta beta beta beta</p>");
    bar.attach(frame);
    expect(count()).toBe("2/4");
  });

  it("forgets a match position the shortened document no longer has", () => {
    openWith("<p>beta beta beta</p>");
    type("beta");
    press("Enter");
    press("Enter");
    press("Enter");
    expect(count()).toBe("3/3");

    const { frame } = reviewed("<p>beta</p>");
    bar.attach(frame);
    expect(count()).toBe("1");
  });

  it("survives being attached to a render that produced no reachable document", () => {
    openWith("<p>beta</p>");
    type("beta");
    bar.attach(null);
    expect(count()).toBe("No results");
    expect(hidden()).toBe(false);
  });
});
