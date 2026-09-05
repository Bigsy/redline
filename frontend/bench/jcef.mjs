// Real packaged JCEF smoke check. Uses page CDP because JCEF does not implement browser contexts.
// Start sandbox with -Dide.browser.jcef.debug.port=9223 and the testdata/jcef pair.
import { readFileSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
const targets = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const target = targets.find((p) => p.url.includes("redline.localhost"));
assert(target, "Packaged Redline page must be open");
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
let next = 0;
const pending = new Map();
ws.onmessage = ({ data }) => {
  const message = JSON.parse(data);
  if (message.id) {
    const p = pending.get(message.id);
    pending.delete(message.id);
    message.error ? p.reject(message.error) : p.resolve(message.result);
  }
};
const call = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++next;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const r = await call("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
};
const mode = async (value) =>
  evaluate(
    `document.querySelector('[title="${value} (${value === "Original" ? 1 : value === "Redline" ? 2 : 3})"]').click();new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`,
  );
const report = { runtime: await evaluate("navigator.userAgent"), checks: [] };
await mode("Redline");
const initial = await evaluate(
  `({nav:!!document.querySelector('.redline-nav'),banners:[...document.querySelectorAll('.redline-banner')].map(e=>e.textContent),markers:document.querySelector('iframe').contentDocument.querySelectorAll('[data-diff-op]').length,worker:performance.getEntriesByName('redline-worker').map(e=>({duration:e.duration,timings:e.detail}))})`,
);
assert(initial.nav);
assert(initial.markers > 0);
report.checks.push({ name: "packaged worker rendered", ...initial });
for (const [value, path] of [
  ["Original", "../testdata/jcef/before.html"],
  ["Final", "../testdata/jcef/after.html"],
]) {
  await mode(value);
  const source = readFileSync(path, "utf8");
  const exact = await evaluate(
    `(()=>{const actual=document.querySelector('iframe').contentDocument.body.cloneNode(true);actual.querySelectorAll('[data-redline-current]').forEach(e=>e.removeAttribute('data-redline-current'));actual.normalize();const expected=new DOMParser().parseFromString(${JSON.stringify(source)},'text/html').body;expected.normalize();return actual.isEqualNode(expected)})()`,
  );
  assert(exact, value + " exact body");
  report.checks.push({
    name: value + " exact body",
    ticks: await evaluate(`document.querySelectorAll('.redline-tick').length`),
  });
}
await mode("Redline");
await evaluate(`window.__redlineNav('next')`);
const counter = await evaluate(
  `document.querySelector('.redline-nav-count').textContent`,
);
assert(/^[1-9][0-9]* \/ [1-9]/.test(counter));
report.checks.push({ name: "toolbar bridge navigation", counter });
const find = await evaluate(
  `(()=>{window.dispatchEvent(new KeyboardEvent('keydown',{key:'f',metaKey:true,bubbles:true}));const input=document.querySelector('.redline-findbar-search');input.value='world';input.dispatchEvent(new Event('input',{bubbles:true}));return document.querySelector('.redline-findbar-count').textContent})()`,
);
assert(find.includes("1"));
report.checks.push({ name: "find query", count: find });
await evaluate(
  `window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`,
);
try {
  const shot = await call("Page.captureScreenshot", { format: "png" });
  writeFileSync(
    "../docs/engine-integration/jcef.png",
    Buffer.from(shot.data, "base64"),
  );
} catch (error) {
  report.screenshotError = String(error);
}
// Refresh and swapped resource payloads exercise the packaged shell + real worker. Native
// IntelliJ toolbar dispatch and Document/VFS notifications remain a separate manual gate.
await evaluate(
  `window.__nativeFetch=window.fetch;window.__payloads=null;window.fetch=async(...args)=>{const url=String(args[0]);if(window.__payloads&&/\\/(before|after)\\.html$/.test(url))return new Response(window.__payloads[url.endsWith('before.html')?'before':'after']);return window.__nativeFetch(...args)};`,
);
const waitFor = async (expression) =>
  evaluate(
    `new Promise((resolve,reject)=>{const start=Date.now();const poll=()=>{if(${expression})resolve(true);else if(Date.now()-start>10000)reject(new Error('JCEF state timeout'));else setTimeout(poll,25)};poll()})`,
  );
const before = readFileSync("../testdata/jcef/before.html", "utf8");
const after = readFileSync("../testdata/jcef/after.html", "utf8");
await mode("Final");
await evaluate(
  `window.__payloads=${JSON.stringify({ before, after: after.replace("new clause", "refreshed clause") })};window.__redlineReload()`,
);
await waitFor(
  `document.querySelector('.redline-nav') && document.querySelector('iframe').contentDocument.body.textContent.includes('refreshed clause')`,
);
assert.equal(
  await evaluate(
    `document.querySelector('iframe').contentDocument.documentElement.dataset.redlineMode`,
  ),
  "final",
);
report.checks.push({
  name: "packaged shell live refresh, mode preserved",
  resourcePayloads: "test-injected",
});
await evaluate(
  `window.__payloads=${JSON.stringify({ before: after, after: before })};window.__redlineReload()`,
);
await waitFor(
  `document.querySelector('.redline-nav') && document.querySelector('iframe').contentDocument.body.textContent.includes('old clause')`,
);
report.checks.push({
  name: "swapped resource payloads in packaged shell",
  nativeToolbarDispatch: false,
});
await evaluate(
  `window.__payloads=null;window.fetch=window.__nativeFetch;window.__NativeWorker=Worker;window.Worker=class extends window.__NativeWorker{postMessage(data){this.timer=setTimeout(()=>super.postMessage(data),5000)}terminate(){clearTimeout(this.timer);window.__terminated=true;super.terminate()}};window.__redlineReload()`,
);
await waitFor(`document.querySelector('.redline-cancel')`);
await evaluate(`document.querySelector('.redline-cancel').click()`);
await waitFor(
  `document.querySelector('.redline-banner.warning')?.textContent.includes('cancelled')`,
);
assert(await evaluate("window.__terminated"));
report.checks.push({
  name: "packaged cancellation and safe fallback",
  delayedRealWorker: true,
});
await evaluate(
  `window.Worker=class {constructor(){throw new Error('Unavailable-worker regression')}};window.__redlineReload()`,
);
await waitFor(
  `document.querySelector('.redline-banner.warning')?.textContent.includes('worker unavailable')`,
);
report.checks.push({ name: "packaged unavailable-worker fallback" });
await evaluate(`window.Worker=window.__NativeWorker;window.__redlineReload()`);
await waitFor(`document.querySelector('.redline-nav')`);
report.remaining = [
  "Native Swap Sides toolbar click and IntelliJ Document/VFS edit notification: standalone Java sandbox is not addressable by available computer-use app API. Kotlin session update/swap tests pass; shell behavior tested above.",
];
writeFileSync(
  "../docs/engine-integration/jcef-results.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));
ws.close();
