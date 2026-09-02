import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyTheme, bootSession } from "./viewer";

/**
 * Shell state-machine tests. happy-dom can exercise the fetch/banner/fallback wiring; it cannot
 * prove browser sandbox enforcement or layout-driven behavior — that stays a manual runIde check
 * (a real-Chromium test is a PLAN.md follow-up).
 */

function sides(before: string, after: string): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const body = String(url).endsWith("before.html") ? before : after;
      return { ok: true, text: async () => body } as Response;
    }),
  );
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
