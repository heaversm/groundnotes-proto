// Highlights as positions in the article's text.
// A highlight is { start, end } in the root's text, plus its quote and a little context on each side
// (the way Hypothesis anchors annotations), so it can be found again if positions drift.
// Painting splits overlapping highlights into segments and wraps each segment once, so any number of
// readers' highlights can be layered — which is also what the heat map needs.

const CONTEXT = 32;

// Every text node under root, with its start position in the combined text.
export function textIndex(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let text = "";
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push({ node: n, start: text.length });
    text += n.data;
  }
  return { nodes, text };
}

// Text length from the start of root to a boundary point. Range.toString() joins text nodes exactly as textIndex does.
function offsetOf(root, container, offset) {
  if (!root.contains(container)) return null;
  const r = document.createRange();
  r.setStart(root, 0);
  r.setEnd(container, offset);
  return r.toString().length;
}

// A DOM selection range → { start, end, quote, prefix, suffix }, trimmed of surrounding spaces.
export function rangeToAnchor(root, range) {
  const index = textIndex(root);
  let start = offsetOf(root, range.startContainer, range.startOffset);
  let end = offsetOf(root, range.endContainer, range.endOffset);
  if (start == null || end == null || end <= start) return null;
  while (start < end && /\s/.test(index.text[start])) start++;
  while (end > start && /\s/.test(index.text[end - 1])) end--;
  if (end - start < 3) return null;
  return anchorAt(index.text, start, end);
}

export function anchorAt(text, start, end) {
  return {
    start, end,
    quote: text.slice(start, end),
    prefix: text.slice(Math.max(0, start - CONTEXT), start),
    suffix: text.slice(end, end + CONTEXT),
  };
}

// Normalised text with a map back to original positions: curly quotes straightened, runs of space collapsed.
function normalise(s) {
  let out = "";
  const map = [];
  let lastSpace = false;
  for (let i = 0; i < s.length; i++) {
    let c = s[i];
    if (/[‘’ʼ]/.test(c)) c = "'";
    else if (/[“”]/.test(c)) c = '"';
    else if (/[–—]/.test(c)) c = "-";
    if (/\s/.test(c)) {
      if (lastSpace) continue;
      c = " ";
      lastSpace = true;
    } else lastSpace = false;
    out += c;
    map.push(i);
  }
  return { out, map };
}

// Where is this highlight in the text now? Returns { start, end } or null.
export function locate(text, h) {
  if (Number.isInteger(h.start) && Number.isInteger(h.end) && text.slice(h.start, h.end) === h.quote) {
    return { start: h.start, end: h.end };
  }
  const T = normalise(text);
  const Q = normalise(h.quote.trim()).out;
  if (!Q) return null;
  const hits = [];
  for (let i = T.out.indexOf(Q); i !== -1; i = T.out.indexOf(Q, i + 1)) hits.push(i);
  if (!hits.length) return null;
  // Several matches: prefer the one whose surrounding text matches, then the one nearest the old position.
  const pre = h.prefix ? normalise(h.prefix).out.slice(-12) : "";
  const score = (i) => {
    let s = 0;
    if (pre && T.out.slice(Math.max(0, i - pre.length - 1), i).includes(pre.trim())) s += 1000;
    if (Number.isInteger(h.start)) s -= Math.abs(T.map[i] - h.start) / 1000;
    return s;
  };
  const best = hits.sort((a, b) => score(b) - score(a))[0];
  const start = T.map[best];
  const endNorm = best + Q.length - 1;
  const end = T.map[endNorm] + 1;
  return { start, end };
}

// Remove all painted marks, leaving plain text.
export function unpaint(root) {
  for (const m of root.querySelectorAll("mark.gn")) m.replaceWith(...m.childNodes);
  root.normalize();
}

// Paint ranges: [{ key, start, end }]. decorate(keys, markEl) styles each segment.
export function paint(root, ranges, decorate) {
  unpaint(root);
  if (!ranges.length) return;
  const cuts = new Set();
  for (const r of ranges) { cuts.add(r.start); cuts.add(r.end); }
  const boundaries = [...cuts].sort((a, b) => a - b);
  const index = textIndex(root);
  for (const { node, start } of index.nodes) {
    const end = start + node.data.length;
    const local = boundaries.filter((b) => b > start && b < end).map((b) => b - start);
    // Split from the end so earlier offsets stay valid.
    const pieces = [];
    for (let i = local.length - 1; i >= 0; i--) {
      const tail = node.splitText(local[i]);
      pieces.unshift({ node: tail, start: start + local[i] });
    }
    pieces.unshift({ node, start });
    for (const p of pieces) {
      const pEnd = p.start + p.node.data.length;
      if (!p.node.data.length) continue;
      const keys = ranges.filter((r) => r.start <= p.start && r.end >= pEnd && r.end > r.start).map((r) => r.key);
      if (!keys.length) continue;
      // Leave whitespace-only pieces between block elements alone.
      if (!p.node.data.trim() && p.node.parentNode && !/^(P|LI|BLOCKQUOTE|H\d|FIGCAPTION|EM|STRONG|A|B|I)$/.test(p.node.parentNode.tagName)) continue;
      const mark = document.createElement("mark");
      mark.className = "gn";
      mark.dataset.keys = keys.join(" ");
      p.node.replaceWith(mark);
      mark.append(p.node);
      decorate(keys, mark);
    }
  }
}

// How much two ranges overlap, as a share of the shorter one.
export function overlap(a, b) {
  const inter = Math.min(a.end, b.end) - Math.max(a.start, b.start);
  if (inter <= 0) return 0;
  return inter / Math.min(a.end - a.start, b.end - b.start);
}

export function scrollToRange(root, start) {
  const index = textIndex(root);
  const hit = index.nodes.find((n) => n.start <= start && n.start + n.node.data.length > start);
  const target = hit?.node.parentElement?.closest("mark.gn") || hit?.node.parentElement;
  if (!target) return;
  target.scrollIntoView({ behavior: "smooth", block: "center" });
  if (target.matches("mark.gn")) { target.classList.remove("flash"); void target.offsetWidth; target.classList.add("flash"); }
}
