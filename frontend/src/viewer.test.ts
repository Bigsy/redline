import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyTheme, bootSession } from "./viewer";

/**
 * Shell state-machine tests. happy-dom can exercise the fetch/banner/fallback wiring; it cannot
 * prove browser sandbox enforcement or layout-driven behavior — that stays a manual runIde check
 * (a real-Chromium test is a PLAN.md follow-up).
 */

/**
 * Serve both sides, with the served text mutable — changing it models an edit landing in the IDE
 * before Kotlin calls `__redlineReload`.
 */
function mutableSides(before: string, after: string): { before: string; after: string } {
  const served = { before, after };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const body = String(url).endsWith("before.html") ? served.before : served.after;
      return { ok: true, text: async () => body } as Response;
    }),
  );
  return served;
}

function sides(before: string, after: string): void {
  mutableSides(before, after);
}

/**
 * happy-dom has no layout, so `scrollHeight`/`clientHeight` are 0 everywhere and the scroll
 * restore's clamp would flatten every offset to 0 — proving nothing. Fake a document of a given
 * height by redefining the getters where they actually live (Element.prototype), and hand back
 * the undo. Prototype-level because the frame the offset is restored INTO is created inside the
 * re-render, so there is no instance to shadow beforehand.
 */
function fakeLayout(scrollHeight: number, clientHeight: number): () => void {
  const restore: (() => void)[] = [];
  for (const [name, value] of [
    ["scrollHeight", scrollHeight],
    ["clientHeight", clientHeight],
  ] as const) {
    let owner: object | null = document.documentElement;
    while (owner && !Object.getOwnPropertyDescriptor(owner, name)) owner = Object.getPrototypeOf(owner);
    if (!owner) throw new Error(`no ${name} descriptor to fake`);
    const original = Object.getOwnPropertyDescriptor(owner, name)!;
    Object.defineProperty(owner, name, { configurable: true, get: () => value });
    const target = owner;
    restore.push(() => Object.defineProperty(target, name, original));
  }
  return () => restore.forEach((undo) => undo());
}

function banners(): { kind: string; text: string }[] {
  return [...document.querySelectorAll(".redline-banner")].map((el) => ({
    kind: el.className.replace("redline-banner", "").trim(),
    text: el.textContent ?? "",
  }));
}

function frame(): HTMLIFrameElement {
  const el = document.querySelector<HTMLIFrameElement>("iframe.redline-frame");
  if (!el) throw new Error("no frame rendered");
  return el;
}

const doc = (body: string) => `<!doctype html><html><head></head><body>${body}</body></html>`;

/** An engine run that never finishes, so the time budget or Cancel is the only way out. */
const stalledEngine = () => () => ({ result: new Promise<string>(() => {}), terminate: () => {} });

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  delete window.__redlineNav;
  delete window.__redlineReport;
  delete window.__redlineFlush;
  delete window.__redlineReload;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("viewer truthfulness states", () => {
  it("state 1 — identical: shows the after side with a 'no changes' banner", async () => {
    sides(doc("<p>same</p>"), doc("<p>same</p>"));
    await bootSession("s1");
    expect(banners()).toEqual([{ kind: "info", text: "No changes — both sides are identical." }]);
    expect(frame().src).toContain("/doc/s1/after.html");
    expect(frame().getAttribute("sandbox")).toBe("allow-same-origin");
  });

  it("state 4 — fetch failure: warning banner and the after side, never a blank pane", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, text: async () => "" }) as Response),
    );
    await bootSession("s1");
    const [banner] = banners();
    expect(banner.kind).toBe("warning");
    expect(banner.text).toContain("Redline diff failed");
    expect(banner.text).toContain("HTTP 500");
    expect(frame().src).toContain("/doc/s1/after.html");
  });

  it("state 3 — changed but unrepresentable: warning banner and the after side", async () => {
    sides(doc('<p class="old">same text</p>'), doc('<p class="new">same text</p>'));
    await bootSession("s1");
    const [banner] = banners();
    expect(banner.kind).toBe("warning");
    expect(banner.text).toContain("not visible in rendered form");
    expect(frame().src).toContain("/doc/s1/after.html");
  });

  it("state 3 — whitespace-only change: info banner saying the rendered document is unchanged", async () => {
    sides(doc("<p>same text</p>"), doc("\n  <p>same text</p>\n"));
    await bootSession("s1");
    const [banner] = banners();
    expect(banner.kind).toBe("info");
    expect(banner.text).toBe("Only whitespace or line endings differ — the rendered document is unchanged.");
    expect(frame().src).toContain("/doc/s1/after.html");
  });

  it("state 2 — marked changes: no banner, redline written into the sandboxed frame", async () => {
    sides(doc("<p>old text</p>"), doc("<p>new text</p>"));
    await bootSession("s1");
    expect(banners()).toEqual([]);
    const written = frame().contentDocument;
    expect(written?.querySelector("ins.redline")).not.toBeNull();
    expect(frame().src).toBe(""); // content was written, not navigated
  });

  it("state 2 with invisible extras — marked changes plus attribute change: incomplete-highlights banner", async () => {
    sides(doc('<p class="old">old text</p>'), doc('<p class="new">new text</p>'));
    await bootSession("s1");
    const [banner] = banners();
    expect(banner.kind).toBe("warning");
    expect(banner.text).toContain("highlights below are incomplete");
    expect(frame().contentDocument?.querySelector("ins.redline")).not.toBeNull();
  });

  it("state 0 — added file (empty before): the new document plainly, with an info banner", async () => {
    sides("", doc("<p>new</p>"));
    await bootSession("s1");
    const [banner] = banners();
    expect(banner.kind).toBe("info");
    expect(banner.text).toContain("added");
    expect(frame().src).toContain("/doc/s1/after.html");
    expect(window.__redlineNav).toBeUndefined();
  });

  it("state 0 — deleted file (empty after): the removed document plainly, with an info banner", async () => {
    sides(doc("<p>old</p>"), "   \n");
    await bootSession("s1");
    const [banner] = banners();
    expect(banner.kind).toBe("info");
    expect(banner.text).toContain("deleted");
    expect(frame().src).toContain("/doc/s1/before.html");
  });

  it("state 2 exposes toolbar navigation and reports nav state over the bridge", async () => {
    const report = vi.fn();
    window.__redlineReport = report;
    sides(doc("<p>old text</p>"), doc("<p>new text</p>"));
    await bootSession("s1");

    // happy-dom has no layout, so every marker measures zero-height: block count is 0. The
    // wiring is what's under test — geometry-driven counts are the Playwright/runIde suites' job.
    expect(window.__redlineNav).toBeDefined();
    expect(() => window.__redlineNav!("next")).not.toThrow();
    expect(report).toHaveBeenCalledWith("0,-1");

    // Kotlin injects __redlineReport late and then calls __redlineFlush to pull current state.
    report.mockClear();
    window.__redlineFlush!();
    expect(report).toHaveBeenCalledWith("0,-1");
  });

  it("states without navigation still answer a bridge flush with an empty state", async () => {
    sides(doc("<p>same</p>"), doc("<p>same</p>"));
    await bootSession("s1");
    const report = vi.fn();
    window.__redlineReport = report;
    window.__redlineFlush!();
    expect(report).toHaveBeenCalledWith("0,-1");
  });

  it("state 5 — too large: skips the engine, warns, and shows the after side", async () => {
    // Over SIZE_LIMIT (2 MB across both sides): the engine is never asked.
    const huge = doc(`<p>${"x".repeat(1_100_000)}</p>`);
    sides(huge, huge.replace("x", "y"));
    await bootSession("s1");
    const [banner] = banners();
    expect(banner.kind).toBe("warning");
    expect(banner.text).toContain("too large for the rendered redline");
    expect(banner.text).not.toContain("gave up after"); // no run was attempted
    expect(frame().src).toContain("/doc/s1/after.html");
  });

  it("state 5 — timed out: warns with the budget it gave up on, and shows the after side", async () => {
    sides(doc("<p>old text</p>"), doc("<p>new text</p>"));
    // happy-dom has no Worker, so the real engine runs inline and finishes before any budget can
    // expire; a stalled engine is the only way to reach the give-up path headlessly.
    await bootSession("s1", { timeoutMs: 5, execute: stalledEngine() });
    const [banner] = banners();
    expect(banner.kind).toBe("warning");
    expect(banner.text).toContain("too large for the rendered redline");
    expect(banner.text).toContain("gave up after");
    expect(frame().src).toContain("/doc/s1/after.html");
  });

  it("the Computing banner is gone once the redline lands", async () => {
    sides(doc("<p>old text</p>"), doc("<p>new text</p>"));
    await bootSession("s1");
    expect(banners()).toEqual([]);
    expect(document.querySelector(".redline-cancel")).toBeNull();
    expect(frame().contentDocument?.querySelector("ins.redline")).not.toBeNull();
  });

  it("the Computing banner is shown while the engine runs, with a working Cancel", async () => {
    sides(doc("<p>old text</p>"), doc("<p>new text</p>"));
    const booting = bootSession("s1", { timeoutMs: 60_000, execute: stalledEngine() });

    const cancel = await vi.waitFor(() => {
      const button = document.querySelector<HTMLButtonElement>(".redline-cancel");
      if (!button) throw new Error("no cancel button yet");
      return button;
    });
    expect(banners()[0]).toMatchObject({ kind: "info" });
    expect(banners()[0].text).toContain("Computing redline");

    cancel.click();
    await booting;

    // Same shape as the give-up state: the document is intact, only the redline was abandoned.
    const [banner] = banners();
    expect(banner.kind).toBe("warning");
    expect(banner.text).toContain("cancelled");
    expect(frame().src).toContain("/doc/s1/after.html");
    expect(document.querySelector(".redline-cancel")).toBeNull();
  });

  it("applyTheme sets the shell theme from the URL parameter, defaulting to light", () => {
    applyTheme("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    applyTheme(null);
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("session ids are URL-encoded into the doc base", async () => {
    const fetched: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        fetched.push(String(url));
        return { ok: true, text: async () => doc("<p>same</p>") } as Response;
      }),
    );
    await bootSession("s/1");
    expect(fetched.every((u) => u.includes("/doc/s%2F1/"))).toBe(true);
  });
});

/**
 * Live refresh (batch C): Kotlin replaces the live session's content in place and calls
 * `window.__redlineReload`, which refetches the same URLs and re-runs the state machine. The
 * hook returns void (it is driven from `executeJavaScript`), so these tests wait for the
 * re-render to land rather than awaiting it.
 */
describe("live refresh", () => {
  it("re-renders in place, replacing the previous state's banner rather than stacking one", async () => {
    const served = mutableSides(doc("<p>same</p>"), doc("<p>same</p>"));
    await bootSession("s1");
    expect(banners()).toEqual([{ kind: "info", text: "No changes — both sides are identical." }]);

    served.after = doc("<p>edited</p>");
    window.__redlineReload!();
    await vi.waitFor(() => {
      expect(frame().contentDocument?.querySelector("ins.redline")).not.toBeNull();
    });

    // The "no changes" banner belonged to the previous render; two banners would be a lie.
    expect(banners()).toEqual([]);
    expect(frame().contentDocument?.querySelector("ins.redline")?.textContent).toContain("edited");
  });

  it("leaves exactly one frame, minimap and nav strip behind after several reloads", async () => {
    const served = mutableSides(doc("<p>old text</p>"), doc("<p>new text</p>"));
    await bootSession("s1");

    for (const word of ["newer", "newest"]) {
      served.after = doc(`<p>${word} text</p>`);
      window.__redlineReload!();
      await vi.waitFor(() => {
        expect(frame().contentDocument?.body.textContent).toContain(word);
      });
    }

    expect(document.querySelectorAll("iframe.redline-frame")).toHaveLength(1);
    expect(document.querySelectorAll(".redline-content")).toHaveLength(1);
    // A leaked minimap keeps listening on the SHELL window and scrolls a detached document.
    expect(document.querySelectorAll(".redline-minimap")).toHaveLength(1);
    expect(document.querySelectorAll(".redline-nav")).toHaveLength(1);
  });

  it("re-reports nav state so the IDE toolbar follows the new document", async () => {
    const served = mutableSides(doc("<p>old text</p>"), doc("<p>new text</p>"));
    await bootSession("s1");
    const report = vi.fn();
    window.__redlineReport = report;

    served.after = doc("<p>edited text</p>");
    window.__redlineReload!();
    // Synchronously, during tear-down and before a single byte is refetched: the toolbar must
    // disable while the new blocks are measured rather than act on the old document's count.
    expect(report).toHaveBeenCalledWith("0,-1");

    report.mockClear();
    await vi.waitFor(() => {
      expect(frame().contentDocument?.body.textContent).toContain("edited");
    });
    // …and the flush Kotlin uses after a bridge re-injection answers with the new state.
    window.__redlineFlush!();
    expect(report).toHaveBeenCalledWith("0,-1");
  });

  it("restores the reader's scroll offset", async () => {
    const undoLayout = fakeLayout(5000, 500);
    try {
      const served = mutableSides(doc("<p>old text</p>"), doc("<p>new text</p>"));
      await bootSession("s1");
      frame().contentWindow!.scrollTo(0, 400);
      expect(frame().contentWindow!.scrollY).toBe(400);

      served.after = doc("<p>edited text</p>");
      window.__redlineReload!();
      await vi.waitFor(() => {
        expect(frame().contentDocument?.body.textContent).toContain("edited");
      });

      // A fresh frame starts at 0; 400 means the offset was carried across the re-render.
      await vi.waitFor(() => expect(frame().contentWindow!.scrollY).toBe(400));
    } finally {
      undoLayout();
    }
  });

  it("clamps the restored offset when the edit made the document shorter", async () => {
    const served = mutableSides(doc("<p>old text</p>"), doc("<p>new text</p>"));
    await bootSession("s1");
    frame().contentWindow!.scrollTo(0, 4000); // happy-dom does not clamp, so this sticks

    // The edit shortened the document: 1000 px of content under a 300 px viewport leaves 700 px
    // of scroll. 700 is neither the raw offset nor the 0 a fresh frame starts at, so this fails
    // if the clamp goes AND if the restore goes.
    const undoLayout = fakeLayout(1000, 300);
    try {
      served.after = doc("<p>edited text</p>");
      window.__redlineReload!();
      await vi.waitFor(() => {
        expect(frame().contentDocument?.body.textContent).toContain("edited");
      });
      await vi.waitFor(() => expect(frame().contentWindow!.scrollY).toBe(700));
    } finally {
      undoLayout();
    }
  });

  it("keeps the reader's place when a reload lands while the previous render is still fetching", async () => {
    const served = { before: doc("<p>old text</p>"), after: doc("<p>new text</p>") };
    let hold: Promise<void> = Promise.resolve();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        await hold;
        const body = String(url).endsWith("before.html") ? served.before : served.after;
        return { ok: true, text: async () => body } as Response;
      }),
    );

    const undoLayout = fakeLayout(5000, 500);
    try {
      await bootSession("s1");
      frame().contentWindow!.scrollTo(0, 400);

      // Two keystroke-driven reloads in a row, the first still parked on its fetch when the
      // second arrives. By then the first render has already installed a fresh frame sitting at
      // the top of the document — reading the offset off THAT frame loses the reader's place.
      let release = (): void => {};
      hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      served.after = doc("<p>first edit</p>");
      window.__redlineReload!();
      served.after = doc("<p>second edit</p>");
      window.__redlineReload!();
      release();

      await vi.waitFor(() => {
        expect(frame().contentDocument?.body.textContent).toContain("second edit");
      });
      await vi.waitFor(() => expect(frame().contentWindow!.scrollY).toBe(400));
    } finally {
      undoLayout();
    }
  });

  it("a reload mid-diff abandons the in-flight run without it reporting a state", async () => {
    mutableSides(doc("<p>old text</p>"), doc("<p>new text</p>"));
    const booting = bootSession("s1", { timeoutMs: 400, execute: stalledEngine() });
    await vi.waitFor(() => {
      if (!document.querySelector(".redline-cancel")) throw new Error("engine not running yet");
    });

    // Kotlin pushes an edit while the engine is still going. The in-flight run is aborted BY the
    // new render, which is not a state the reader should be told about — only the new render's
    // outcome is. Both runs stall here, so the surviving banner must be the second's timeout, not
    // the first's "cancelled".
    window.__redlineReload!();
    await booting;

    await vi.waitFor(() => {
      expect(banners()).toHaveLength(1);
      expect(banners()[0].text).toContain("gave up after");
    });
    expect(banners()[0].kind).toBe("warning");
  });
});
