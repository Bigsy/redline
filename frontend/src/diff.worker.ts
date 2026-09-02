// The engine call, off the main thread.
//
// node-htmldiff is quadratic in token count and runs to completion once started: on the shell's
// main thread a large document freezes the whole pane with no feedback and no way out (measured
// 72 s for a 262 KB pair, >5 min for 650 KB). Only this step can move — it is pure string in,
// string out; the parsing and reconstruction around it need DOMParser, which workers do not have.
//
// The worker is terminated by the caller on timeout or cancel (see diff.ts#runEngine), which is
// the only way to stop the engine mid-run.
import htmldiff from "./vendor/htmldiff";

export interface EngineRequest {
  before: string;
  after: string;
  className: string;
  atomicTags: string;
}

export type EngineResponse = { html: string } | { error: string };

// `self` is typed as Window by the DOM lib; the worker globals are narrowed here rather than
// pulling the webworker lib into a project whose other files are DOM code.
const ctx = self as unknown as {
  postMessage(message: EngineResponse): void;
  addEventListener(type: "message", listener: (event: MessageEvent<EngineRequest>) => void): void;
};

ctx.addEventListener("message", (event) => {
  const { before, after, className, atomicTags } = event.data;
  try {
    ctx.postMessage({ html: htmldiff(before, after, className, null, atomicTags) });
  } catch (error) {
    ctx.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
});
