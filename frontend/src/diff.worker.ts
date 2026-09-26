import { compareBodies, renderMerged } from "redline-engine";
import { renderMarkdown } from "./markdown";
import {
  HOST_LIMITS,
  type EngineResponse,
  type MarkdownResponse,
  type WorkerRequest,
} from "./engine-protocol";
const ctx = self as unknown as {
  postMessage(message: EngineResponse | MarkdownResponse): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<WorkerRequest>) => void,
  ): void;
};
ctx.addEventListener("message", ({ data }) => {
  if (data.kind === "markdown") {
    try {
      ctx.postMessage({ kind: "markdown", outcome: "success", html: renderMarkdown(data.source) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const limit = message.includes("input limit")
        ? "input"
        : message.includes("output limit")
          ? "output"
          : null;
      ctx.postMessage(
        limit
          ? { kind: "markdown", outcome: "limit", limit }
          : { kind: "markdown", outcome: "failure", message },
      );
    }
    return;
  }
  try {
    const result = compareBodies({
      beforeHtml: data.before,
      afterHtml: data.after,
      limits: HOST_LIMITS,
    });
    if (result.outcome === "success") {
      const { modelVersion, diagnostics, timings } = result.comparison;
      ctx.postMessage({
        outcome: "success",
        html: renderMerged(result.comparison).html,
        modelVersion,
        diagnostics,
        timings,
      });
    } else ctx.postMessage(result);
  } catch (error) {
    ctx.postMessage({ outcome: "failure", message: String(error) });
  }
});
