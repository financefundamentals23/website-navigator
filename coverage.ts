/* Element-coverage report: which interactive patterns the scanner actually sees.
 * Run: npm run coverage   (fails if coverage drops below the recorded baseline)
 * The known gaps are documented in docs/coverage.md. */
import http from "node:http";
import { readFileSync } from "node:fs";
import { crawl } from "./crawl.ts";
import { getElements } from "./db.ts";
const PORT = 8794;
const html = readFileSync("docs/coverage-fixture.html", "utf8");
const srv = http.createServer((_q, r) =>
  r.writeHead(200, { "content-type": "text/html" }).end(html));
await new Promise<void>((r) => srv.listen(PORT, r));
await crawl("cov", `http://localhost:${PORT}/`, { maxPages: 1, respectRobots: false });
const found = new Set(
  getElements("cov").flatMap((e) => (e.label.match(/C\d\d/g) ?? [])),
);
const cases: Record<string, string> = {
  C01: "anchor with href", C02: "anchor, role=link, no href", C03: "anchor, onclick only",
  C04: "button", C05: "div with onclick", C06: "div role=button", C07: "span with tabindex",
  C08: "disabled button", C09: "aria-hidden button (should be EXCLUDED)",
  C10: "icon button + aria-label", C11: "icon button, svg <title> only", C12: "icon button, img alt",
  C13: "button labelled by aria-labelledby", C14: "input with <label for>", C15: "wrapping <label>",
  C16: "input placeholder", C17: "checkbox", C18: "select", C19: "option 1", C20: "option 2",
  C21: "textarea", C22: "submit input", C23: "role=menuitem", C24: "role=tab", C25: "role=option",
  C26: "role=combobox", C27: "role=slider", C28: "role=switch", C29: "role=treeitem",
  C30: "hover menu trigger", C31: "item inside hover menu", C32: "button in shadow DOM",
  C33: "button in iframe", C34: "contenteditable",
};
const miss: string[] = [];
console.log("");
for (const [id, desc] of Object.entries(cases)) {
  const ok = found.has(id);
  const expectMiss = id === "C09";
  const mark = ok ? "\x1b[32mfound  \x1b[0m" : expectMiss ? "\x1b[32mexcluded\x1b[0m" : "\x1b[31mMISSED \x1b[0m";
  if (!ok && !expectMiss) miss.push(`${id} ${desc}`);
  if (ok && expectMiss) miss.push(`${id} ${desc} -- indexed but should not be`);
  console.log(`  ${id}  ${mark}  ${desc}`);
}
console.log(`\n${Object.keys(cases).length - miss.length}/${Object.keys(cases).length} handled correctly`);
if (miss.length) console.log("\ngaps:\n" + miss.map((m) => "  - " + m).join("\n"));
srv.close();

const BASELINE = 31; // raise this when a gap is closed; never lower it silently
const score = Object.keys(cases).length - miss.length;
if (score < BASELINE) {
  console.error("\n\x1b[31mcoverage regressed: " + score + ", baseline " + BASELINE + "\x1b[0m");
  process.exit(1);
}
process.exit(0);
