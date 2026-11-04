// Tries extraction on URLs given as arguments and prints a short report for each.
import { extract } from "../netlify/lib/extract.mjs";
for (const u of process.argv.slice(2)) {
  try {
    const a = await extract(u);
    const text = a.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    console.log(`OK  ${u}\n    ${a.site} | ${a.title} | ${text.length} chars | ${(a.html.match(/<p>/g) || []).length} paragraphs\n    ${text.slice(0, 160)}…`);
  } catch (e) {
    console.log(`ERR ${u}\n    ${e.message}`);
  }
}
