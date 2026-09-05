// Explicit unit-test worker mock. Never imported by production code.
import { beforeEach, vi } from "vitest";
import { compareBodies, renderMerged } from "redline-engine";
import { HOST_LIMITS, type EngineRequest } from "./engine-protocol";
class TestWorker extends EventTarget {
  terminate() {}
  postMessage(data: EngineRequest) {
    queueMicrotask(() => {
      const result = compareBodies({
        beforeHtml: data.before,
        afterHtml: data.after,
        limits: HOST_LIMITS,
      });
      this.dispatchEvent(
        new MessageEvent("message", {
          data:
            result.outcome === "success"
              ? {
                  outcome: "success",
                  html: renderMerged(result.comparison).html,
                  modelVersion: 1,
                  diagnostics: result.comparison.diagnostics,
                  timings: result.comparison.timings,
                }
              : result,
        }),
      );
    });
  }
}
beforeEach(() => vi.stubGlobal("Worker", TestWorker));
