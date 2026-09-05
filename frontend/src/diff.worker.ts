import { compareBodies, renderMerged } from "redline-engine";
import {
  HOST_LIMITS,
  type EngineRequest,
  type EngineResponse,
} from "./engine-protocol";
const ctx = self as unknown as {
  postMessage(message: EngineResponse): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<EngineRequest>) => void,
  ): void;
};
ctx.addEventListener("message", ({ data }) => {
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
