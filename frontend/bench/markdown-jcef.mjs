// Run after launching runIde on testdata/markdown/{before,after}.md with
// JAVA_TOOL_OPTIONS=-Dide.browser.jcef.debug.port=9223. Uses the real packaged page/worker.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const debugPort = process.env.JCEF_DEBUG_PORT ?? "9223";
const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
const target = targets.find((page) => page.url.includes("redline.localhost") && page.url.includes("format=markdown"));
assert(target, "Open the Markdown demo in the packaged Redline viewer first");
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let sequence = 0;
const pending = new Map();
ws.onmessage = ({ data }) => {
  const message = JSON.parse(data);
  if (!message.id) return;
  const promise = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) promise.reject(message.error);
  else promise.resolve(message.result);
};
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const result = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
};
const waitFor = (expression) => evaluate(`new Promise((resolve,reject)=>{
  const start=Date.now();const poll=()=>{if(${expression})resolve(true);
  else if(Date.now()-start>15000)reject(new Error('Packaged viewer timed out'));
  else setTimeout(poll,25)};poll()})`);
const mode = async (name) => {
  await evaluate(`document.querySelector('[title="${name} (${name === "Original" ? 1 : name === "Redline" ? 2 : 3})"]').click()`);
};
const bodyText = () => evaluate("document.querySelector('iframe').contentDocument.body.textContent");
const report = { runtime: await evaluate("navigator.userAgent"), url: target.url, checks: [] };
try {
  await waitFor("document.querySelector('.redline-nav')");
  await mode("Redline");
  assert((await bodyText()).includes("reassuring"));
  assert((await bodyText()).includes("stable"));
  report.checks.push("Markdown Compare Files selects Redline and loads the packaged conversion/comparison workers");
  const precision = await evaluate(`(()=>{const doc=document.querySelector('iframe').contentDocument;return {
    replacedTableBody:!!doc.querySelector('tbody[data-diff-node]'),
    inlineMetadata:!!doc.querySelector('.redline-frontmatter-source ins[data-diff-op]'),
    inlineCell:!!doc.querySelector('td ins[data-diff-op]'),
    notice:document.querySelector('.redline-banner')?.textContent
  }})()`);
  assert.equal(precision.replacedTableBody, false);
  assert(precision.inlineMetadata && precision.inlineCell);
  assert(precision.notice.includes("Changed code blocks are shown in full"));
  report.checks.push("Metadata and table cells have inline changes; whole-block notice applies only to code");
  await mode("Original");
  assert((await bodyText()).includes('review = "stable"'));
  assert(!(await bodyText()).includes("reassuring"));
  await mode("Final");
  assert((await bodyText()).includes('review = "reassuring"'));
  assert(!(await bodyText()).includes('review = "stable"'));
  report.checks.push("Original and Final preserve prose and fenced-code revisions");
  await mode("Redline");
  await evaluate("window.__redlineNav('next')");
  assert.match(await evaluate("document.querySelector('.redline-nav-count').textContent"), /^[1-9][0-9]* \/ [1-9]/);
  report.checks.push("IDE navigation bridge selects a change");
  await evaluate(`(()=>{window.dispatchEvent(new KeyboardEvent('keydown',{key:'f',metaKey:true,bubbles:true}));
    const input=document.querySelector('.redline-findbar-search');input.value='reassuring';input.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  assert.match(await evaluate("document.querySelector('.redline-findbar-count').textContent"), /[1-9]/);
  await evaluate("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
  report.checks.push("Find searches rendered Markdown");
  const originalTheme = await evaluate("document.documentElement.dataset.theme");
  for (const theme of ["light", "dark"]) {
    await evaluate(`document.documentElement.dataset.theme='${theme}'`);
    await waitFor(`document.querySelector('iframe').contentDocument.documentElement.dataset.redlineTheme==='${theme}'`);
    mkdirSync("../docs/markdown", { recursive: true });
    const shot = await call("Page.captureScreenshot", { format: "png" });
    writeFileSync(`../docs/markdown/jcef-${theme}.png`, Buffer.from(shot.data, "base64"));
  }
  await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(originalTheme)}`);
  report.checks.push("Markdown canvas follows live IDE theme updates");
  // Payload injection tests packaged shell refresh, not the native IDE Document/VFS listener.
  const before = readFileSync("../testdata/markdown/before.md", "utf8");
  const after = readFileSync("../testdata/markdown/after.md", "utf8");
  await evaluate(`window.__markdownNativeFetch=window.fetch;window.__markdownPayloads=${JSON.stringify({ before, after: after.replaceAll("reassuring", "refreshed") })};
    window.fetch=(...args)=>{const url=String(args[0]);if(/\\/(before|after)\\.html$/.test(url))return Promise.resolve(new Response(window.__markdownPayloads[url.endsWith('before.html')?'before':'after']));return window.__markdownNativeFetch(...args)}`);
  await mode("Final");
  await evaluate("window.__redlineReload()");
  await waitFor("document.querySelector('.redline-nav') && document.querySelector('iframe').contentDocument.body.textContent.includes('refreshed')");
  assert.equal(await evaluate("document.querySelector('iframe').contentDocument.documentElement.dataset.redlineMode"), "final");
  report.checks.push("Packaged shell refresh preserves Final mode (test-injected payload)");
  report.limitations = ["Native Swap Sides toolbar dispatch and actual Document/VFS edit notifications are not exercised by this CDP script."];
} finally {
  await evaluate("if(window.__markdownNativeFetch){window.fetch=window.__markdownNativeFetch;delete window.__markdownNativeFetch;delete window.__markdownPayloads;window.__redlineReload()}");
  writeFileSync("../docs/markdown/jcef-results.json", JSON.stringify(report, null, 2) + "\n");
  ws.close();
}
console.log(JSON.stringify(report, null, 2));
