// Saves the extracted text of each URL to tools/cache (git-ignored), for writing sample readers' quotes.
import { writeFile } from "node:fs/promises";
import { parseHTML } from "linkedom";
import { extract } from "../netlify/lib/extract.mjs";
for (const u of process.argv.slice(2)) {
  const a = await extract(u);
  const { document } = parseHTML(`<div id="r">${a.html}</div>`);
  const paras = [...document.querySelectorAll("p, h2, h3, li, blockquote, figcaption")].map((p) => p.textContent.trim()).filter(Boolean);
  await writeFile(`tools/cache/${a.id}.txt`, `${a.title}\n${a.url}\n\n${paras.join("\n\n")}\n`);
  console.log(a.id, a.title);
}
