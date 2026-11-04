// Shared bits: talking to the server, local storage, tags, small DOM helpers.

export const TAGS = [
  { id: "observation", label: "Observation" },
  { id: "question", label: "Question" },
  { id: "followup", label: "Follow up" },
  { id: "disagree", label: "Disagree" },
  { id: "remember", label: "Remember" },
];
export const tagLabel = (id) => TAGS.find((t) => t.id === id)?.label ?? id;

// Colours for other readers' underlines, assigned in order.
export const READER_COLORS = ["#2f5d50", "#b0503a", "#4a5fa8", "#8a5a9e", "#a07a14", "#3b7f8f"];

export async function api(path, { method = "GET", body, token } = {}) {
  const headers = {};
  if (body) headers["content-type"] = "application/json";
  if (token) headers["x-reader-token"] = token;
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({ error: `The server answered ${res.status}.` }));
  if (data.error) throw Object.assign(new Error(data.error), { data });
  return data;
}

export const store = {
  get(key, fallback = null) {
    try { return JSON.parse(localStorage.getItem(`gn:${key}`)) ?? fallback; } catch { return fallback; }
  },
  set(key, value) { localStorage.setItem(`gn:${key}`, JSON.stringify(value)); },
  del(key) { localStorage.removeItem(`gn:${key}`); },
};

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "style" && typeof v === "object") {
      for (const [prop, val] of Object.entries(v)) {
        if (prop.startsWith("--")) node.style.setProperty(prop, val);
        else node.style[prop] = val;
      }
    }
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (k === "html") node.innerHTML = v;
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function tagChip(id) {
  return el("span", { class: `tag ${id}` }, tagLabel(id));
}

export function toast(message, ms = 2600) {
  const t = el("div", { class: "toast", role: "status" }, message);
  document.body.append(t);
  setTimeout(() => t.remove(), ms);
}

export const shorten = (s, n = 140) => (s.length > n ? `${s.slice(0, n).trimEnd()}…` : s);
export const uid = () => Math.random().toString(36).slice(2, 10);

// Text with links turned into anchors that show only the site name.
export function linkify(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(/https?:\/\/[^\s<>"')]+/g)) {
    out.push(text.slice(last, m.index));
    let host = m[0];
    try { host = new URL(m[0]).hostname.replace(/^www\./, ""); } catch {}
    out.push(el("a", { href: m[0], target: "_blank", rel: "noopener noreferrer nofollow", class: "msg-link" }, `${host} ↗`));
    last = m.index + m[0].length;
  }
  out.push(text.slice(last));
  return out;
}
