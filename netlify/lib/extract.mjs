// Turns a web page into a clean article with Readability, the library behind Firefox's Reader View.
import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.0; rv:140.0) Gecko/20100101 Firefox/140.0";

// Strip tracking parameters and fragments so the same article gets the same id.
export function normalizeUrl(raw) {
  const url = new URL(raw);
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_|fbclid|gclid|mc_|ref$|partner$|cmpid)/i.test(key)) url.searchParams.delete(key);
  }
  url.hostname = url.hostname.replace(/^www\./, "");
  return url.toString().replace(/\/$/, "");
}

export async function articleId(url) {
  const bytes = new TextEncoder().encode(url);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Keep only the tags the reader needs. Everything else is unwrapped to its text.
const KEEP = new Set(["P", "H2", "H3", "H4", "BLOCKQUOTE", "UL", "OL", "LI", "EM", "STRONG", "B", "I", "A", "FIGURE", "FIGCAPTION", "IMG", "BR"]);

function clean(node, doc) {
  for (const child of [...node.childNodes]) {
    if (child.nodeType !== 1) continue;
    const tag = child.tagName;
    if (["SCRIPT", "STYLE", "IFRAME", "FORM", "BUTTON", "SVG", "NOSCRIPT", "VIDEO", "PICTURE", "SOURCE"].includes(tag)) {
      if (tag === "PICTURE") {
        const img = child.querySelector("img");
        if (img) child.replaceWith(img);
        else child.remove();
        continue;
      }
      child.remove();
      continue;
    }
    clean(child, doc);
    if (!KEEP.has(tag)) {
      child.replaceWith(...child.childNodes);
      continue;
    }
    for (const attr of [...child.attributes]) {
      const keep = (tag === "A" && attr.name === "href") || (tag === "IMG" && (attr.name === "src" || attr.name === "alt"));
      if (!keep) child.removeAttribute(attr.name);
    }
    if (tag === "A") {
      child.setAttribute("target", "_blank");
      child.setAttribute("rel", "noopener noreferrer");
    }
  }
}

export async function extract(rawUrl) {
  const url = normalizeUrl(rawUrl);
  const res = await fetch(rawUrl, { headers: { "User-Agent": UA, Accept: "text/html" }, redirect: "follow" });
  if (!res.ok) throw new Error(`The site answered ${res.status}`);
  const html = await res.text();
  const { document } = parseHTML(html);
  // Resolve relative links and images against the page address.
  for (const el of document.querySelectorAll("a[href], img[src]")) {
    const attr = el.tagName === "A" ? "href" : "src";
    try { el.setAttribute(attr, new URL(el.getAttribute(attr), res.url).toString()); } catch {}
  }
  for (const img of document.querySelectorAll("img[data-src]")) {
    if (!img.getAttribute("src")) img.setAttribute("src", img.getAttribute("data-src"));
  }
  const article = new Readability(document, { charThreshold: 400 }).parse();
  if (!article || !article.content || (article.textContent || "").trim().length < 600) {
    throw new Error("Couldn't find an article on that page");
  }
  const { document: out } = parseHTML(`<!doctype html><html><body><div id="root">${article.content}</div></body></html>`);
  const root = out.getElementById("root");
  clean(root, out);
  // Drop empty paragraphs and the site furniture Readability sometimes keeps (author cards, citation blocks).
  const JUNK = /^(Full profile|Citation:|This document is subject to copyright|Who's behind this story|Explore further|More information:|Provided by)/i;
  for (const p of root.querySelectorAll("p, h2, h3, h4")) {
    const t = p.textContent.trim();
    if ((!t && !p.querySelector("img")) || JUNK.test(t)) p.remove();
  }
  // Readability can repeat a figure's caption as a paragraph right after it.
  for (const cap of root.querySelectorAll("figcaption")) {
    const next = cap.parentNode?.nextElementSibling;
    if (next && next.tagName === "P" && next.textContent.trim() === cap.textContent.trim()) next.remove();
  }
  return {
    id: await articleId(url),
    url,
    title: (article.title || "").trim(),
    byline: (article.byline || "").trim(),
    site: (article.siteName || new URL(url).hostname).trim(),
    excerpt: (article.excerpt || "").trim(),
    published: article.publishedTime || null,
    html: root.innerHTML.trim(),
    fetchedAt: new Date().toISOString(),
  };
}
