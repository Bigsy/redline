// Generates a large, purely synthetic HTML pair for manually exercising large-document rendering
// (PLAN.md item B5): the engine is quadratic in token count, and repetitive markup is deliberately
// its worst case. Sparse, aligned edits in this fixture should take the partitioned fast path and
// render normally; the 15-second guard remains the fallback for shapes that cannot be partitioned.
//
// Not part of any build or test suite — run it by hand and point runIde at the output:
//   node generate.mjs [paragraphCount]
//   ../../gradlew runIde --args="diff testdata/large/generated/before.html testdata/large/generated/after.html"
//
// Output goes to generated/, which is gitignored: regenerate rather than commit multi-hundred-KB
// fixtures.
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "generated");
const count = Number(process.argv[2] ?? 6000);

function paragraph(i, changed) {
  const text = changed
    ? `This paragraph number ${i} has been edited to exercise the size guard.`
    : `This is paragraph number ${i} of a large synthetic document used for manual testing.`;
  return `<p>${text} <b>Bold segment ${i}</b> and <a href="#s${i}">a link to section ${i}</a>.</p>\n`;
}

function build(edited) {
  const parts = [
    "<!doctype html><html><head><meta charset=\"utf-8\"><title>Large synthetic document</title></head><body>\n",
  ];
  for (let i = 0; i < count; i++) {
    parts.push(paragraph(i, edited && i % 50 === 0));
  }
  parts.push("</body></html>\n");
  return parts.join("");
}

const before = build(false);
const after = build(true);

mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "before.html"), before);
writeFileSync(join(dir, "after.html"), after);

console.log(`before.html: ${(before.length / 1024).toFixed(0)} KB`);
console.log(`after.html:  ${(after.length / 1024).toFixed(0)} KB`);
console.log(`edited paragraphs: ${Math.ceil(count / 50)}`);
