import { expect, it, vi } from "vitest";
import {
  buildRedline,
  DiffCancelledError,
  DiffEngineError,
  DiffTimeoutError,
  prepareMarkdown,
  runEngine,
} from "./diff";
import type { EngineResponse, EngineSuccess } from "./engine-protocol";
const success: EngineSuccess = {
  outcome: "success",
  html: "<p>same</p>",
  modelVersion: 1,
  diagnostics: [],
  timings: { parseMs: 0, matchMs: 0, renderMs: 0, validateMs: 0, totalMs: 0 },
};
it("terminates successful and rejected executors exactly once", async () => {
  for (const fails of [false, true]) {
    const terminate = vi.fn();
    await runEngine("a", "b", {
      execute: () => ({
        result: fails
          ? Promise.reject(new Error("broken"))
          : Promise.resolve(success),
        terminate,
      }),
    }).catch(() => {});
    expect(terminate).toHaveBeenCalledTimes(1);
  }
});
it("never constructs an executor for an already aborted request", async () => {
  const execute = vi.fn();
  await expect(
    runEngine("a", "b", { execute, signal: AbortSignal.abort() }),
  ).rejects.toBeInstanceOf(DiffCancelledError);
  expect(execute).not.toHaveBeenCalled();
});
it("terminates a Markdown preparation worker on timeout and cancellation", async () => {
  const instances: { terminate: ReturnType<typeof vi.fn> }[] = [];
  vi.stubGlobal(
    "Worker",
    class extends EventTarget {
      terminate = vi.fn();
      constructor() {
        super();
        instances.push(this);
      }
      postMessage() {}
    },
  );
  await expect(prepareMarkdown("# title", { timeoutMs: 5 })).rejects.toBeInstanceOf(
    DiffTimeoutError,
  );
  expect(instances[0].terminate).toHaveBeenCalledOnce();

  const controller = new AbortController();
  const pending = prepareMarkdown("# title", { signal: controller.signal });
  controller.abort();
  await expect(pending).rejects.toBeInstanceOf(DiffCancelledError);
  expect(instances[1].terminate).toHaveBeenCalledOnce();
});
it("worker construction failure rejects without an inline comparison", async () => {
  vi.stubGlobal(
    "Worker",
    class {
      constructor() {
        throw new Error("blocked");
      }
    },
  );
  await expect(runEngine("a", "b")).rejects.toThrow("worker unavailable");
});
for (const response of [
  { outcome: "limit", limit: "maxOutputUnits", diagnostics: [] },
  { outcome: "unsupported", diagnostics: [] },
  { outcome: "failure", message: "broken" },
] satisfies EngineResponse[])
  it(`preserves ${response.outcome} outcomes and terminates`, async () => {
    const terminate = vi.fn();
    vi.stubGlobal(
      "Worker",
      class extends EventTarget {
        terminate = terminate;
        postMessage() {
          queueMicrotask(() =>
            this.dispatchEvent(new MessageEvent("message", { data: response })),
          );
        }
      },
    );
    const error = await runEngine("a", "b").catch((e) => e);
    expect(error).toBeInstanceOf(DiffEngineError);
    expect(error.response).toEqual(response);
    expect(terminate).toHaveBeenCalledOnce();
  });
it("declines either browser projection mismatch, including empty elements and whitespace", async () => {
  for (const html of ["<p>same</p>", "<p>same</p><hr>", "<p>same </p>"]) {
    await expect(
      buildRedline("<p>same</p>", "<p>same</p><br>", undefined, {
        execute: () => ({
          result: Promise.resolve({ ...success, html }),
          terminate() {},
        }),
      }),
    ).rejects.toThrow("Unsupported browser projection");
  }
});
