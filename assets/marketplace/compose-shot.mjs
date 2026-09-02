// One-off marketplace-asset composer (not part of the build): renders a two-panel
// "text diff vs Redline" comparison and screenshots it with the Playwright chromium.
//
// It imports @playwright/test, which is only installed in frontend/node_modules, so run it
// from `frontend/` (where Node resolves that dependency):
//   cd frontend && pnpm run shot ../<demo.diff> ../<hero-crop.png> ../<out.png>
// which is `node ../assets/marketplace/compose-shot.mjs <demo.diff> <hero-crop.png> <out.png>`.
import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";

const [, , diffPath, cropPath, outPath] = process.argv;

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const diffLines = readFileSync(diffPath, "utf8")
  .split("\n")
  .map((line) => {
    let cls = "ctx";
    if (line.startsWith("+++") || line.startsWith("---")) cls = "meta";
    else if (line.startsWith("@@")) cls = "hunk";
    else if (line.startsWith("+")) cls = "add";
    else if (line.startsWith("-")) cls = "del";
    return `<div class="ln ${cls}">${esc(line) || "&nbsp;"}</div>`;
  })
  .join("");

const cropB64 = readFileSync(cropPath).toString("base64");

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    width: 1600px; height: 1000px; overflow: hidden;
    font-family: -apple-system, 'SF Pro Display', 'Segoe UI', sans-serif;
    background: linear-gradient(160deg, #eef1f5 0%, #dde3ea 100%);
    display: flex; flex-direction: column; align-items: center; padding: 34px 60px 40px;
  }
  h1 { font-size: 30px; font-weight: 700; color: #1c2128; letter-spacing: -0.01em; }
  .cards { display: flex; gap: 36px; margin-top: 26px; flex: 1; width: 100%; }
  .card {
    flex: 1; display: flex; flex-direction: column; border-radius: 12px; overflow: hidden;
    box-shadow: 0 12px 40px rgba(20, 30, 45, 0.18), 0 2px 8px rgba(20, 30, 45, 0.10);
  }
  .card-label {
    padding: 12px 18px; font-size: 15px; font-weight: 600; letter-spacing: 0.01em;
  }
  .left .card-label { background: #15171a; color: #9ba0a6; }
  .right .card-label { background: #ffffff; color: #3b4048; border-bottom: 1px solid #e6e8eb; }
  .left .body {
    flex: 1; background: #1e1f22; padding: 14px 18px; overflow: hidden;
    font-family: 'SF Mono', Menlo, monospace; font-size: 12.5px; line-height: 18.5px;
  }
  .ln { white-space: pre; color: #bcbec4; }
  .ln.meta { color: #7a7e85; }
  .ln.hunk { color: #548af7; }
  .ln.add { background: rgba(87, 171, 90, 0.16); color: #a8cca9; }
  .ln.del { background: rgba(229, 83, 75, 0.15); color: #d8a7a3; }
  .right .body { flex: 1; background: #ffffff; overflow: hidden; }
  .right img { width: 100%; display: block; }
  .badge { display: inline-block; font-size: 12px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.08em; padding: 2px 8px; border-radius: 4px; margin-right: 10px;
    position: relative; top: -1px; }
  .left .badge { background: #3d4043; color: #c8ccd1; }
  .right .badge { background: #d9f0da; color: #2e7d32; }
</style></head><body>
  <h1>Review HTML changes as a document, not markup</h1>
  <div class="cards">
    <div class="card left">
      <div class="card-label"><span class="badge">Before</span>The change as a text diff</div>
      <div class="body">${diffLines}</div>
    </div>
    <div class="card right">
      <div class="card-label"><span class="badge">Redline</span>The same change, rendered</div>
      <div class="body"><img src="data:image/png;base64,${cropB64}"></div>
    </div>
  </div>
</body></html>`;

import { writeFileSync } from "node:fs";
const htmlPath = outPath.replace(/\.png$/, ".html");
writeFileSync(htmlPath, html);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
await page.goto(`file://${htmlPath}`, { waitUntil: "networkidle" });
await page.waitForTimeout(300);
try {
  await page.screenshot({ path: outPath });
} catch {
  // Some headless-shell builds refuse hidpi captures; retry at 1x.
  const page1 = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page1.goto(`file://${htmlPath}`, { waitUntil: "networkidle" });
  await page1.screenshot({ path: outPath });
}
await browser.close();
console.log("wrote", outPath);
