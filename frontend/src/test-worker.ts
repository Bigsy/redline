// Explicit unit-test worker mock. Never imported by production code.
import { beforeEach, vi } from "vitest";
import { compareBodies, renderMerged } from "redline-engine";
import { HOST_LIMITS, type WorkerRequest } from "./engine-protocol";
import { renderMarkdown } from "./markdown";
class TestWorker extends EventTarget {
  terminate() {}
  postMessage(data: WorkerRequest) {
    queueMicrotask(() => {
      if (data.kind === "markdown") {
        try {
          this.dispatchEvent(
            new MessageEvent("message", {
              data: { kind: "markdown", outcome: "success", html: renderMarkdown(data.source) },
            }),
          );
        } catch (error) {
          this.dispatchEvent(
            new MessageEvent("message", {
              data: { kind: "markdown", outcome: "failure", message: String(error) },
            }),
          );
        }
        return;
      }
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
