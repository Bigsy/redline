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

interface EngineRequestBase {
  className: string;
  atomicTags: string;
}

/** One aligned body region; equal regions pass through without invoking node-htmldiff. */
export interface EngineChunk {
  before: string;
  after: string;
}

/** A whole-body comparison, or the conservative large-document partitioned form. */
export type EngineRequest = EngineRequestBase &
  ({ before: string; after: string } | { chunks: EngineChunk[] });

export type EngineResponse = { html: string } | { error: string };

// `self` is typed as Window by the DOM lib; the worker globals are narrowed here rather than
// pulling the webworker lib into a project whose other files are DOM code.
const ctx = self as unknown as {
  postMessage(message: EngineResponse): void;
  addEventListener(type: "message", listener: (event: MessageEvent<EngineRequest>) => void): void;
};

ctx.addEventListener("message", (event) => {
  const { className, atomicTags } = event.data;
  try {
    const inputs = "chunks" in event.data
      ? event.data.chunks
      : [{ before: event.data.before, after: event.data.after }];
    const html = inputs
      .map((chunk) =>
        chunk.before === chunk.after
          ? chunk.after
          : htmldiff(chunk.before, chunk.after, className, null, atomicTags),
      )
      .join("");
    ctx.postMessage({ html });
  } catch (error) {
    ctx.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
});
