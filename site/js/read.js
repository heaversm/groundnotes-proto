// The reader: highlight with a tag and a note, submit, then compare with other readers and ask them things.
import { TAGS, READER_COLORS, api, store, el, tagChip, tagLabel, toast, shorten, uid, linkify } from "./common.js";
import { rangeToAnchor, textIndex, locate, paint, overlap, scrollToRange } from "./anchor.js";

const params = new URLSearchParams(location.search);
const sourceUrl = params.get("url");

const state = {
  article: null,
  root: null,
  mine: [],          // my highlights
  me: null,          // { readingId, token, handle } once submitted
  locked: true,
  count: 0,          // readers so far, shown while locked
  others: [],        // [{ id, handle, sample, color, highlights: [...with start/end] }]
  tab: "mine",
  readerId: null,    // the reader being compared in the "One reader" tab
  pending: null,     // the selection being written about
  inbox: { threads: [] },
  prompts: new Map(),
  ai: false,
  presets: [],
  stage: "reading",  // "reading", then "reflect" (before sharing)
  reflections: [],   // my answers to the reflection questions
  myLeft: [],        // questions I left for the next reader
  reflectQs: null,
  readTo: 0,         // how far through the article I've scrolled, 0–1
};

const $article = document.getElementById("article");
const $panel = document.getElementById("panel");
let pop = null;

// ---------- persistence ----------

const draftKey = () => `draft:${state.article.id}`;
const meKey = () => `me:${state.article.id}`;
function saveDraft() { store.set(draftKey(), state.mine); }

let syncTimer = null;
function scheduleSync() {
  saveDraft();
  if (!state.me) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(async () => {
    try {
      await api("/api/reading", { method: "POST", body: { articleId: state.article.id, highlights: state.mine, readTo: state.readTo, token: state.me.token } });
    } catch (e) { toast(`Couldn't save: ${e.message}`); }
  }, 600);
}

// ---------- loading ----------

async function start() {
  if (!sourceUrl) {
    $article.innerHTML = "";
    $article.append(el("div", { class: "error-box" }, el("p", {}, "No article chosen. "), el("a", { href: "index.html" }, "Pick one or paste a link →")));
    return;
  }
  api("/api/status").then((s) => { state.ai = s.ai; state.presets = s.presets; }).catch(() => {});
  try {
    const { article } = await api(`/api/article?url=${encodeURIComponent(sourceUrl)}`);
    state.article = article;
  } catch (e) {
    $article.innerHTML = "";
    $article.append(el("div", { class: "error-box" },
      el("h2", {}, "That page didn't come through"),
      el("p", {}, e.message),
      el("p", {}, "Some sites block readers like this one, or keep articles behind a login. ", el("a", { href: "index.html" }, "Try another link →"))));
    $panel.remove();
    return;
  }
  document.title = `${state.article.title} — Ground Notes`;
  renderArticle();
  state.mine = store.get(draftKey(), []);
  state.me = store.get(meKey());
  state.readTo = store.get(`readto:${state.article.id}`, 0);
  trackReading();
  // Positions are relative to this exact text; re-find any that drifted.
  const { text } = textIndex(state.root);
  state.mine = state.mine.map((h) => ({ ...h, ...(locate(text, h) || {}) })).filter((h) => Number.isInteger(h.start));
  await loadReadings();
  if (!state.locked) {
    state.tab = "one";
    loadInbox();
    setInterval(loadInbox, 20000);
  }
  render();
}

async function loadReadings() {
  const data = await api(`/api/readings?article=${state.article.id}`, { token: state.me?.token });
  state.locked = data.locked;
  if (data.locked) {
    state.count = data.count;
    if (state.me) { store.del(meKey()); state.me = null; } // the server no longer knows this token
    return;
  }
  state.me = { ...state.me, handle: data.mine.handle };
  state.myLeft = data.mine.leftQuestions || [];
  state.reflections = data.mine.reflections || [];
  const { text } = textIndex(state.root);
  state.others = data.readings.map((r, i) => ({
    ...r,
    color: READER_COLORS[i % READER_COLORS.length],
    highlights: r.highlights.map((h) => ({ ...h, ...(locate(text, h) || {}) })).filter((h) => Number.isInteger(h.start)),
  })).filter((r) => r.highlights.length);
  if (!state.readerId || !state.others.some((r) => r.id === state.readerId)) state.readerId = bestMatch()?.id ?? null;
}

async function loadInbox() {
  if (!state.me) return;
  try {
    state.inbox = await api(`/api/inbox?article=${state.article.id}`, { token: state.me.token });
    if (state.tab !== "inbox") return renderTabs();
    // Keep half-written answers (and focus) across the refresh.
    const drafts = new Map([...$panel.querySelectorAll("textarea[data-tid]")].map((t) => [t.dataset.tid, t.value]));
    const focused = document.activeElement?.dataset?.tid;
    if (drafts.size && [...drafts.values()].some(Boolean) || focused) return renderTabs(); // don't redraw under someone typing
    renderPanel();
  } catch {}
}

// ---------- how far I read ----------

function trackReading() {
  let last = state.readTo;
  const update = () => {
    const r = state.root.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (innerHeight * 0.85 - r.top) / r.height));
    if (frac > state.readTo) {
      state.readTo = frac;
      store.set(`readto:${state.article.id}`, frac);
      if (state.me && frac - last > 0.05) { last = frac; scheduleSync(); }
    }
  };
  let ticking = false;
  addEventListener("scroll", () => { if (!ticking) { ticking = true; requestAnimationFrame(() => { ticking = false; update(); }); } }, { passive: true });
  update();
}

// A line in the article where the reader being compared stopped reading.
function drawReadTo() {
  $article.querySelector(".readto")?.remove();
  if (state.locked || state.tab !== "one") return;
  const r = state.others.find((x) => x.id === state.readerId);
  if (!r || r.readTo == null || r.readTo >= 0.97) return;
  const y = state.root.offsetTop + r.readTo * state.root.offsetHeight;
  $article.append(el("div", { class: "readto", style: { top: `${y}px`, "--c": r.color } }, el("span", {}, `${r.handle} stopped reading about here`)));
}

// ---------- comparing ----------

const NEAR_CHARS = 300; // highlights this close count as "close to each other"
const SHOW_FIRST = 3; // longer lists show this many, the rest behind "show more"

function compare(mine, theirs) {
  const used = new Set();
  const shared = [];
  const onlyMine = [];
  for (const m of mine) {
    let best = null;
    let bestScore = 0.3;
    for (const t of theirs) {
      if (used.has(t.id)) continue;
      const s = overlap(m, t);
      if (s >= bestScore) { best = t; bestScore = s; }
    }
    if (best) { used.add(best.id); shared.push({ start: m.start, quote: m.quote, mine: m, theirs: best }); }
    else onlyMine.push(m);
  }
  // Second pass: passages that don't overlap but sit close together, usually in the same paragraph.
  const near = [];
  const leftMine = [];
  for (const m of onlyMine) {
    let best = null;
    let bestGap = NEAR_CHARS;
    for (const t of theirs) {
      if (used.has(t.id)) continue;
      const gap = Math.max(t.start - m.end, m.start - t.end);
      if (gap <= bestGap) { best = t; bestGap = gap; }
    }
    if (best) { used.add(best.id); near.push({ start: Math.min(m.start, best.start), mine: m, theirs: best }); }
    else leftMine.push(m);
  }
  const onlyTheirs = theirs.filter((t) => !used.has(t.id));
  const byStart = (a, b) => a.start - b.start;
  return { shared: shared.sort(byStart), near: near.sort(byStart), onlyMine: leftMine.sort(byStart), onlyTheirs: onlyTheirs.sort(byStart) };
}

// The reader who shares the most ground with you, with something new to show you.
function bestMatch() {
  let best = null;
  let bestScore = -1;
  for (const r of state.others) {
    const c = compare(state.mine, r.highlights);
    const score = c.shared.length * 2 + c.near.length + Math.min(c.onlyTheirs.length, 3) + (r.sample ? 0 : 0.5);
    if (score > bestScore) { best = r; bestScore = score; }
  }
  return best;
}

// Passages several readers marked, most readers first.
function commonGround() {
  const items = [
    ...state.mine.map((h) => ({ h, who: "me", handle: "you" })),
    ...state.others.flatMap((r) => r.highlights.map((h) => ({ h, who: r.id, handle: r.handle, reader: r }))),
  ].sort((a, b) => a.h.start - b.h.start);
  const clusters = [];
  for (const it of items) {
    const c = clusters.find((cl) => overlap(cl.anchor, it.h) >= 0.3);
    if (c) c.items.push(it);
    else clusters.push({ anchor: it.h, items: [it] });
  }
  return clusters
    .map((c) => ({ ...c, readers: new Set(c.items.map((i) => i.who)).size }))
    .filter((c) => c.readers >= 2)
    .sort((a, b) => b.readers - a.readers || a.anchor.start - b.anchor.start);
}

// ---------- article + painting ----------

function renderArticle() {
  const a = state.article;
  $article.innerHTML = "";
  const prose = el("div", { class: "prose", html: a.html });
  $article.append(
    el("div", { class: "source" }, a.site, " · ", el("a", { href: a.url, target: "_blank", rel: "noopener noreferrer" }, "original ↗")),
    el("h1", {}, a.title),
    a.byline ? el("div", { class: "byline" }, a.byline) : el("div", { class: "byline" }),
    prose,
  );
  state.root = prose;
  prose.addEventListener("mouseup", onSelectEnd);
  prose.addEventListener("keyup", (e) => { if (e.shiftKey) onSelectEnd(); });
  prose.addEventListener("touchend", () => setTimeout(onSelectEnd, 50));
  prose.addEventListener("click", onMarkClick);
}

const mineKey = (h) => `m|${h.id}`;
const otherKey = (r, h) => `o|${r.id}|${h.id}`;

function lookup(key) {
  const [kind, a, b] = key.split("|");
  if (kind === "m") return { mine: true, h: state.mine.find((h) => h.id === a) };
  if (kind === "p") return { pending: true };
  const reader = state.others.find((r) => r.id === a);
  return { reader, h: reader?.highlights.find((h) => h.id === b) };
}

function repaint() {
  if (!state.root) return;
  const ranges = [];
  const view = state.locked ? "mine" : state.tab;
  const addMine = () => state.mine.forEach((h) => ranges.push({ key: mineKey(h), start: h.start, end: h.end }));
  if (view === "everyone") {
    addMine();
    state.others.forEach((r) => r.highlights.forEach((h) => ranges.push({ key: otherKey(r, h), start: h.start, end: h.end })));
  } else if (view === "one") {
    addMine();
    const r = state.others.find((x) => x.id === state.readerId);
    r?.highlights.forEach((h) => ranges.push({ key: otherKey(r, h), start: h.start, end: h.end }));
  } else addMine();
  if (state.pending) ranges.push({ key: "p|", start: state.pending.start, end: state.pending.end });

  const totalReaders = state.others.length + 1;
  paint(state.root, ranges, (keys, mark) => {
    if (keys.includes("p|")) { mark.classList.add("pending"); return; }
    if (view === "everyone") {
      const readers = new Set(keys.map((k) => (k.startsWith("m|") ? "me" : k.split("|")[1])));
      mark.classList.add("heat");
      mark.style.setProperty("--heat", (0.14 + 0.62 * (readers.size / totalReaders)).toFixed(2));
      return;
    }
    const mine = keys.find((k) => k.startsWith("m|"));
    if (mine) mark.classList.add(`mine-${lookup(mine).h?.tag || "observation"}`);
    const theirs = keys.find((k) => k.startsWith("o|"));
    if (theirs) {
      mark.classList.add("theirs");
      mark.style.setProperty("--their-color", lookup(theirs).reader?.color);
    }
  });
}

// ---------- selection → composer ----------

function onSelectEnd() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  if (!state.root.contains(range.commonAncestorContainer)) return;
  const anchor = rangeToAnchor(state.root, range);
  if (!anchor) return;
  const rect = range.getBoundingClientRect();
  state.pending = anchor;
  sel.removeAllRanges();
  repaint();
  openComposer({ anchor, rect });
}

function closePop() {
  if (pop) { pop.remove(); pop = null; }
  if (state.pending) { state.pending = null; repaint(); }
}

function placePop(node, rect) {
  document.body.append(node);
  const w = node.offsetWidth;
  const left = Math.min(Math.max(12, rect.left + rect.width / 2 - w / 2 + scrollX), scrollX + document.documentElement.clientWidth - w - 12);
  let top = rect.bottom + scrollY + 10;
  if (rect.bottom + node.offsetHeight + 20 > innerHeight && rect.top > node.offsetHeight + 20) top = rect.top + scrollY - node.offsetHeight - 10;
  top = Math.max(top, scrollY + 70); // stay clear of the sticky top bar
  node.style.left = `${left}px`;
  node.style.top = `${top}px`;
}

function tagPicker(selected, onPick) {
  const wrap = el("div", { class: "tagpick", role: "radiogroup", "aria-label": "Tag" });
  for (const t of TAGS) {
    const b = el("button", { type: "button", role: "radio", "aria-checked": String(t.id === selected), class: t.id === selected ? "on" : "" },
      el("span", { class: "sw", style: { background: `var(--${t.id})` } }), t.label);
    b.addEventListener("click", () => {
      wrap.querySelectorAll("button").forEach((x) => { x.classList.remove("on"); x.setAttribute("aria-checked", "false"); });
      b.classList.add("on");
      b.setAttribute("aria-checked", "true");
      onPick(t.id);
    });
    wrap.append(b);
  }
  return wrap;
}

function openComposer({ anchor, rect, existing }) {
  if (pop) pop.remove();
  let tag = existing?.tag ?? null;
  const note = el("textarea", { placeholder: "What stood out, and why?", "aria-label": "Your note", maxlength: "1200" });
  note.value = existing?.note ?? "";
  const save = el("button", { class: "pill small", type: "button" }, existing ? "Save" : "Add note");
  const req = el("span", { class: "req" });
  const check = () => {
    const ok = tag && note.value.trim().length >= 3;
    save.disabled = !ok;
    req.textContent = !tag ? "Pick a tag" : note.value.trim().length < 3 ? "A note is required" : "";
  };
  note.addEventListener("input", check);
  note.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !save.disabled) save.click(); });
  save.addEventListener("click", () => {
    if (existing) Object.assign(existing, { tag, note: note.value.trim(), at: Date.now() });
    else state.mine.push({ id: uid(), ...anchor, tag, note: note.value.trim(), at: Date.now() });
    state.mine.sort((a, b) => a.start - b.start);
    state.pending = null;
    pop.remove(); pop = null;
    scheduleSync();
    render();
  });
  const del = existing ? el("button", { class: "link-btn danger", type: "button", onclick: () => {
    state.mine = state.mine.filter((h) => h !== existing);
    pop.remove(); pop = null;
    scheduleSync();
    render();
  } }, "Delete") : null;

  pop = el("div", { class: "pop", role: "dialog", "aria-label": "Note on this passage" },
    el("p", { class: "quote" }, `“${shorten(anchor.quote, 160)}”`),
    tagPicker(tag, (t) => { tag = t; check(); note.focus(); }),
    note,
    el("div", { class: "row" }, req, el("span", { class: "spacer" }), del, el("button", { class: "link-btn", type: "button", onclick: closePop }, "Cancel"), save));
  placePop(pop, rect);
  check();
  (tag ? note : pop.querySelector(".tagpick button")).focus({ preventScroll: true });
}

// ---------- clicking a highlight ----------

function onMarkClick(e) {
  const mark = e.target.closest("mark.gn");
  if (!mark || !window.getSelection().isCollapsed) return;
  const keys = mark.dataset.keys.split(" ").filter((k) => !k.startsWith("p|"));
  if (!keys.length) return;
  const rect = mark.getBoundingClientRect();
  const view = state.locked ? "mine" : state.tab;
  if (view === "mine" || view === "inbox" || keys.length === 1 && keys[0].startsWith("m|")) {
    const { h } = lookup(keys.find((k) => k.startsWith("m|")) || "");
    if (h) openComposer({ anchor: h, rect, existing: h });
    return;
  }
  openSpot(keys, rect);
}

function noteCard({ h, reader, mine }, { ask = true } = {}) {
  return el("div", { class: "note", onclick: () => scrollToRange(state.root, h.start) },
    el("div", { class: "who" },
      mine ? el("b", {}, "You") : el("span", { style: { color: reader.color, fontWeight: 600 } }, reader.handle),
      reader?.sample ? el("span", { class: "sample", title: "Written for the demo, not a real reader" }, "sample") : null,
      tagChip(h.tag)),
    el("p", { class: "why" }, h.note),
    !mine && ask && state.me ? el("div", { class: "actions" }, el("button", { class: "pill small ghost", type: "button", onclick: (ev) => { ev.stopPropagation(); openRespond({ reader, h }); } }, "Respond")) : null);
}

function openSpot(keys, rect) {
  if (pop) pop.remove();
  const entries = keys.map(lookup).filter((x) => x.h);
  const quote = entries.reduce((a, b) => (a.h.quote.length <= b.h.quote.length ? a : b)).h.quote;
  pop = el("div", { class: "pop", role: "dialog", "aria-label": "Notes on this passage" },
    el("h4", {}, entries.length === 1 ? "One note here" : `${entries.length} notes here`),
    el("p", { class: "quote" }, `“${shorten(quote, 140)}”`),
    el("div", { class: "spot-list" }, entries.map((x) => noteCard(x))));
  placePop(pop, rect);
}

document.addEventListener("mousedown", (e) => { if (pop && !pop.contains(e.target) && !e.target.closest("mark.gn")) closePop(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closePop(); document.querySelector(".scrim")?.remove(); } });

// ---------- responding ----------
// Ask a question, add something useful (with a link if you like), or answer a question a reader left.
// Ready-made questions go straight through; anything typed is checked for kindness on the server first.

function choices(list, onPick) {
  const wrap = el("div", { class: "options", role: "radiogroup" });
  const name = uid();
  list.forEach((text) => {
    const input = el("input", { type: "radio", name });
    const row = el("label", { class: "option" }, input, el("span", {}, text));
    input.addEventListener("change", () => {
      wrap.querySelectorAll(".option").forEach((o) => o.classList.remove("on"));
      row.classList.add("on");
      onPick(text);
    });
    wrap.append(row);
  });
  wrap.clear = () => { wrap.querySelectorAll("input").forEach((i) => { i.checked = false; }); wrap.querySelectorAll(".option").forEach((o) => o.classList.remove("on")); };
  return wrap;
}

// A box that explains why a message was held back and offers kinder versions.
function heldBox(held, onPick) {
  const box = el("div", { class: "held" },
    el("p", {}, el("b", {}, "Not sent yet. "), held.reason || "This might not land the way you meant."),
    held.suggestions?.length ? el("p", { class: "fine" }, "Pick a version below, or edit yours and try again.") : null);
  if (held.suggestions?.length) box.append(choices(held.suggestions, onPick));
  return box;
}

function openRespond({ reader, h, mode = "ask", question }) {
  closePop();
  let kind = mode;            // "ask" | "add" | "answer"
  let chosen = null;          // a picked option (ready-made, suggested, or a kinder version)
  const scrim = el("div", { class: "scrim", onclick: (e) => { if (e.target === scrim) scrim.remove(); } });
  const modal = el("div", { class: "modal", role: "dialog", "aria-modal": "true" });
  scrim.append(modal);

  const draft = el("textarea", { maxlength: "600" });
  const heldSlot = el("div");
  const send = el("button", { class: "pill", type: "button", disabled: true }, "Send");
  const status = el("span", { class: "fine" });
  const refresh = () => { send.disabled = !(chosen || draft.value.trim().length >= 3); };
  draft.addEventListener("input", () => { if (draft.value.trim()) { chosen = null; modal.querySelectorAll(".options").forEach((o) => o.clear?.()); } refresh(); });

  const body = el("div");
  const draw = () => {
    body.innerHTML = "";
    heldSlot.innerHTML = "";
    chosen = null;
    draft.value = "";
    if (kind === "ask") {
      draft.placeholder = "Or write your own question…";
      const opts = choices(state.presets, (t) => { chosen = t; draft.value = ""; refresh(); });
      const optsSlot = el("div", {}, opts);
      const label = el("p", { class: "fine" }, "Ready-made questions.");
      const suggestBtn = state.ai ? el("button", { class: "pill small ghost", type: "button" }, "Suggest questions for this note") : null;
      suggestBtn?.addEventListener("click", async () => {
        suggestBtn.disabled = true; suggestBtn.textContent = "Thinking…";
        try {
          const out = await api("/api/suggest", { method: "POST", body: { quote: h.quote, note: h.note, text: draft.value } });
          optsSlot.innerHTML = "";
          optsSlot.append(choices(out.questions, (t) => { chosen = t; draft.value = ""; refresh(); }));
          label.textContent = out.source === "ai" ? "Suggested by AI from their note. Each takes a different angle." : "Ready-made questions.";
        } catch (e) { toast(e.message); }
        suggestBtn.disabled = false; suggestBtn.textContent = "Suggest different ones";
        chosen = null; refresh();
      });
      body.append(optsSlot, el("div", { class: "row" }, label, el("span", { class: "spacer" }), suggestBtn));
      if (state.ai) body.append(draft);
      else body.append(el("p", { class: "fine" }, "Writing your own needs the AI kindness check, which is switched off."));
    } else if (kind === "add") {
      draft.placeholder = "Share context, something from your own experience, or a link that might help…";
      body.append(state.ai ? draft : el("p", { class: "fine" }, "Adding your own words needs the AI kindness check, which is switched off."));
    } else {
      draft.placeholder = "Your answer…";
      body.append(state.ai ? draft : el("p", { class: "fine" }, "Answering needs the AI kindness check, which is switched off."));
    }
    refresh();
  };

  const modes = mode === "answer" ? null : el("div", { class: "tabs modes" },
    ...[["ask", "Ask a question"], ["add", "Add something"]].map(([id, label]) => {
      const b = el("button", { type: "button", class: id === kind ? "on" : "" }, label);
      b.addEventListener("click", () => { kind = id; modes.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b)); draw(); });
      return b;
    }));

  send.addEventListener("click", async () => {
    const text = chosen || draft.value.trim();
    send.disabled = true;
    status.textContent = chosen && state.presets.includes(chosen) ? "" : "Checking…";
    try {
      await api("/api/thread", { method: "POST", body: {
        token: state.me.token, articleId: state.article.id, toReadingId: reader.id, toHandle: reader.handle,
        kind, highlightId: h?.id || question?.id || "", quote: kind === "answer" ? question.text : h.quote, text,
      } });
      scrim.remove();
      toast(reader.sample ? "Sent. This is a sample reader, so no reply will come." : `Sent to ${reader.handle}. Replies show up in Conversations.`, 3600);
      loadInbox();
    } catch (e) {
      status.textContent = "";
      if (e.data?.held) {
        heldSlot.innerHTML = "";
        heldSlot.append(heldBox(e.data.held, (t) => { chosen = t; refresh(); }));
        draft.value = draft.value || e.data.held.text;
        chosen = null;
      } else toast(e.message);
      refresh();
    }
  });

  const title = kind === "answer" ? `Answer ${reader.handle}'s question` : `Respond to ${reader.handle}`;
  const context = kind === "answer"
    ? el("div", { class: "context" }, el("p", { class: "quote" }, `“${question.text}”`))
    : el("div", { class: "context" }, el("p", { class: "quote" }, `“${shorten(h.quote, 220)}”`), el("div", {}, tagChip(h.tag), " ", h.note));
  modal.append(
    el("h3", {}, title),
    context,
    modes,
    body,
    heldSlot,
    el("p", { class: "fine" }, "Anything you write is checked for kindness before it's sent. Links show their site name. You both stay anonymous."),
    el("div", { class: "row" }, status, el("span", { class: "spacer" }), el("button", { class: "link-btn", type: "button", onclick: () => scrim.remove() }, "Cancel"), send));
  draw();
  document.body.append(scrim);
}

// ---------- panel ----------

function render() { repaint(); renderPanel(); drawReadTo(); }

const seenKey = () => `seen:${state.article.id}`;
function unreadCount() {
  const seen = store.get(seenKey(), {});
  return state.inbox.threads.filter((t) => t.messages.at(-1)?.by !== state.inbox.me && (t.updatedAt || t.createdAt) > (seen[t.id] || 0)).length;
}
function markSeen() {
  const seen = store.get(seenKey(), {});
  state.inbox.threads.forEach((t) => { seen[t.id] = t.updatedAt || t.createdAt; });
  store.set(seenKey(), seen);
}

function renderTabs() {
  const old = $panel.querySelector(".tabs");
  const tabs = buildTabs();
  if (old && tabs) old.replaceWith(tabs);
}

function buildTabs() {
  if (state.locked) return null;
  const unanswered = unreadCount();
  const tabs = el("div", { class: "tabs", role: "tablist" });
  for (const [id, label] of [["mine", "Mine"], ["one", "One reader"], ["everyone", "Everyone"], ["inbox", "Talk"]]) {
    tabs.append(el("button", { role: "tab", "aria-selected": String(state.tab === id), class: state.tab === id ? "on" : "", type: "button",
      onclick: () => { state.tab = id; closePop(); render(); if (id === "inbox") loadInbox(); } },
      label, id === "inbox" && unanswered ? el("span", { class: "badge" }, unanswered) : null));
  }
  return tabs;
}

function renderPanel() {
  $panel.innerHTML = "";
  const tabs = buildTabs();
  if (tabs) $panel.append(tabs);
  if (state.locked) return panelLocked();
  ({ mine: panelMine, one: panelOne, everyone: panelEveryone, inbox: panelInbox })[state.tab]();
}

function myNotes() {
  if (!state.mine.length) return el("p", { class: "empty" }, "Nothing yet. Select a sentence in the article to start.");
  return el("ul", { class: "notes" }, state.mine.map((h) => el("li", { class: "note", onclick: () => scrollToRange(state.root, h.start) },
    el("p", { class: "quote" }, `“${h.quote}”`),
    el("div", { class: "who" }, tagChip(h.tag)),
    el("p", { class: "why" }, h.note))));
}

function panelLocked() {
  if (state.stage === "reflect") return panelReflect();
  const others = state.count;
  const done = el("button", { class: "pill", type: "button", disabled: !state.mine.length }, "I'm done reading");
  done.addEventListener("click", () => { state.stage = "reflect"; closePop(); renderPanel(); $panel.scrollTop = 0; });
  $panel.append(
    el("h2", {}, "Your notes"),
    el("p", { class: "hint" }, "Select any passage to highlight it, pick a tag, and say why it stood out. The why is what other readers will see."),
    el("div", { class: "lock" },
      el("span", { class: "count" }, others),
      el("span", {}, others === 1 ? "other reader has been here. " : "other readers have been here. ", "Their notes open once you share yours, so you read it your own way first.")),
    myNotes(),
    el("div", { class: "submit-bar" }, done));
}

// Between reading and seeing others: two questions drawn from your own notes, and a question for the next reader.
function panelReflect() {
  const answers = [];
  const list = el("div", { class: "reflect-list" }, el("p", { class: "empty" }, "Thinking of questions from your notes…"));
  const note = el("p", { class: "source-note" });
  const left = el("textarea", { placeholder: "A question for whoever reads this next (optional)", maxlength: "300" });
  left.value = state.myLeft[0]?.text || "";
  const heldSlot = el("div");
  const share = el("button", { class: "pill", type: "button" }, state.count ? "Share and see what others noticed" : "Share my notes");
  const drawQs = (out) => {
    list.innerHTML = "";
    answers.length = 0;
    out.questions.forEach((q, i) => {
      const ta = el("textarea", { placeholder: "Optional — a sentence or two", maxlength: "800" });
      ta.value = state.reflections.find((r) => r.prompt === q)?.answer || "";
      answers.push({ prompt: q, ta });
      list.append(el("div", { class: "reflect-q" }, el("p", { class: "q" }, q), ta));
    });
    note.textContent = out.source === "ai" ? "Asked by AI from your own notes. Your answers are shown to other readers." : "Your answers are shown to other readers.";
  };
  if (state.reflectQs) drawQs(state.reflectQs);
  else api("/api/reflect", { method: "POST", body: { title: state.article.title, mine: state.mine } })
    .then((out) => { state.reflectQs = out; if (list.isConnected) drawQs(out); })
    .catch(() => drawQs({ questions: ["What surprised you most in this piece?", "What would you want to ask someone else who read it?"], source: "templates" }));

  share.addEventListener("click", async () => {
    share.disabled = true;
    share.textContent = left.value.trim() ? "Checking and sharing…" : "Sharing…";
    heldSlot.innerHTML = "";
    const reflections = answers.map(({ prompt, ta }) => ({ prompt, answer: ta.value.trim() })).filter((r) => r.answer);
    const leftQuestions = state.ai && left.value.trim() ? [{ text: left.value.trim() }] : [];
    try {
      const res = await api("/api/reading", { method: "POST", body: { articleId: state.article.id, highlights: state.mine, readTo: state.readTo, reflections, leftQuestions, token: state.me?.token } });
      state.me = { readingId: res.readingId, token: res.token, handle: res.handle };
      store.set(meKey(), state.me);
      saveDraft();
      state.stage = "reading";
      await loadReadings();
      state.tab = state.others.length ? "one" : "mine";
      render();
      loadInbox();
      setInterval(loadInbox, 20000);
      toast(`You're reading as “${res.handle}”.`, 3200);
    } catch (e) {
      if (e.data?.held) heldSlot.append(heldBox(e.data.held, (t) => { left.value = t; }));
      else toast(e.message);
      share.disabled = false;
      share.textContent = "Try again";
    }
  });
  $panel.append(
    el("h2", {}, "Before you look"),
    el("p", { class: "hint" }, "A moment with your own reading first. Everything here is optional."),
    list, note,
    el("div", { class: "group-label" }, "Leave a question"),
    el("p", { class: "hint" }, state.ai ? "Other readers can answer it, and you'll see their answers under Talk. It's checked for kindness first." : "Leaving a question needs the AI kindness check, which is switched off."),
    state.ai ? left : null, heldSlot,
    el("div", { class: "row", style: { marginTop: "10px" } }, el("button", { class: "link-btn", type: "button", onclick: () => { state.stage = "reading"; renderPanel(); } }, "← Back to my notes")),
    el("div", { class: "submit-bar" }, share));
}

function panelMine() {
  $panel.append(
    el("h2", {}, "Your notes"),
    el("p", { class: "hint" }, `You're “${state.me.handle}”. Keep highlighting; changes save as you go.`),
    myNotes());
  if (state.reflections.length) {
    $panel.append(el("div", { class: "group-label" }, "Your reflections"));
    state.reflections.forEach((r) => $panel.append(el("div", { class: "reflect-q" }, el("p", { class: "q" }, r.prompt), el("p", { class: "why" }, r.answer))));
  }
  if (state.myLeft.length) {
    $panel.append(el("div", { class: "group-label" }, "Your question for other readers"));
    state.myLeft.forEach((q) => $panel.append(el("p", { class: "talk-q" }, q.text)));
  }
}

function readerChips() {
  const best = bestMatch();
  const wrap = el("div", { class: "readers" });
  for (const r of state.others) {
    wrap.append(el("button", { class: `reader-chip ${r.id === state.readerId ? "on" : ""}`, type: "button", style: { "--c": r.color },
      onclick: () => { state.readerId = r.id; render(); } },
      el("span", { class: "dot" }), r.handle, r.sample ? el("span", { class: "sample" }, "sample") : null, r.id === best?.id ? " ★" : null));
  }
  return wrap;
}

function panelOne() {
  const r = state.others.find((x) => x.id === state.readerId);
  if (!r) {
    $panel.append(el("h2", {}, "No one else yet"), el("p", { class: "hint" }, "You're the first reader here. When someone else reads it, you'll see them side by side."));
    return;
  }
  const c = compare(state.mine, r.highlights);
  const best = bestMatch();
  $panel.append(
    el("h2", {}, "Side by side"),
    el("p", { class: "hint" }, "Your highlights are filled in. Theirs are underlined in their colour."),
    readerChips());
  if (r.id === best?.id) $panel.append(el("p", { class: "match-note" }, `★ ${c.shared.length ? `You and ${r.handle} marked ${c.shared.length} of the same ${c.shared.length === 1 ? "passage" : "passages"}` : c.near.length ? `You and ${r.handle} marked passages close to each other` : `${r.handle} noticed things you didn't`}, so you're matched first.`));

  // Things to talk about.
  const talk = el("ul", { class: "talk" }, el("li", { class: "empty" }, "Finding questions for the two of you…"));
  const talkNote = el("p", { class: "source-note" });
  const relatedSlot = el("div");
  $panel.append(el("div", { class: "group-label" }, "Things to talk about"), talk, talkNote, relatedSlot);
  loadPrompts(r, c, talk, talkNote, relatedSlot);

  if (r.reflections?.length) {
    $panel.append(el("div", { class: "group-label" }, `${r.handle}'s reflections`));
    r.reflections.forEach((x) => $panel.append(el("div", { class: "reflect-q" }, el("p", { class: "q" }, x.prompt), el("p", { class: "why" }, x.answer))));
  }
  if (r.leftQuestions?.length) {
    $panel.append(el("div", { class: "group-label" }, `${r.handle} left a question`));
    r.leftQuestions.forEach((q) => $panel.append(el("div", { class: "note" }, el("p", { class: "why" }, q.text),
      el("div", { class: "actions" }, el("button", { class: "pill small ghost", type: "button", onclick: () => openRespond({ reader: r, mode: "answer", question: q }) }, "Answer")))));
  }

  const quoteLine = (q) => el("p", { class: "quote", style: { font: "italic 15px/1.45 var(--serif)", color: "var(--ink-2)", margin: "0 0 4px" } }, `“${shorten(q, 160)}”`);
  const askBtn = (h) => el("div", { class: "actions" }, el("button", { class: "pill small ghost", type: "button", onclick: (e) => { e.stopPropagation(); openRespond({ reader: r, h }); } }, "Respond"));
  const pair = (s, label) => el("div", { class: "note", onclick: () => scrollToRange(state.root, s.start) },
    label ? el("div", { class: "differ" }, label) : null,
    el("div", { class: "who" }, el("b", {}, "You"), tagChip(s.mine.tag)), quoteLine(s.mine.quote), el("p", { class: "why" }, s.mine.note),
    el("div", { class: "who", style: { marginTop: "10px" } }, el("span", { style: { color: r.color, fontWeight: 600 } }, r.handle), tagChip(s.theirs.tag)),
    s.theirs.quote !== s.mine.quote ? quoteLine(s.theirs.quote) : null, el("p", { class: "why" }, s.theirs.note),
    askBtn(s.theirs));
  // Long lists show the first few; the rest fold away.
  const section = (label, items, make, empty) => {
    if (!items.length && !empty) return;
    $panel.append(el("div", { class: "group-label" }, label, el("span", {}, items.length)));
    if (!items.length) return $panel.append(el("p", { class: "empty" }, empty));
    const list = el("div", { class: "notes" }, items.slice(0, SHOW_FIRST).map(make));
    $panel.append(list);
    if (items.length > SHOW_FIRST) {
      const rest = el("details", { class: "more" }, el("summary", {}, `Show ${items.length - SHOW_FIRST} more`), el("div", { class: "notes" }, items.slice(SHOW_FIRST).map(make)));
      $panel.append(rest);
    }
  };
  section("You both marked", c.shared, (s) => pair(s, s.mine.tag !== s.theirs.tag ? "Same passage, different reasons" : null),
    c.near.length ? null : "No passages in common yet.");
  section("Close to each other", c.near, (s) => pair(s, null));
  section("Only they noticed", c.onlyTheirs, (h) => el("div", {}, quoteLine(h.quote), noteCard({ h, reader: r })));
  // What I marked after they stopped reading isn't something they missed.
  const cutoff = r.readTo != null && r.readTo < 0.97 ? r.readTo : null;
  const beyond = (h) => cutoff != null && h.start / Math.max(1, textIndex(state.root).text.length) > cutoff;
  const mineBefore = c.onlyMine.filter((h) => !beyond(h));
  const mineAfter = c.onlyMine.filter(beyond);
  section("Only you noticed", mineBefore, (h) => el("div", {}, quoteLine(h.quote), noteCard({ h, mine: true })));
  section(`After ${r.handle} stopped reading`, mineAfter, (h) => el("div", {}, quoteLine(h.quote), noteCard({ h, mine: true })));
}

async function loadPrompts(r, c, list, note, relatedSlot) {
  const key = `${r.id}:${state.mine.map((h) => h.id + h.tag + h.note.length).join(",")}`;
  let out = state.prompts.get(key);
  if (!out) {
    try {
      out = await api("/api/prompts", { method: "POST", body: { title: state.article.title, shared: c.shared, onlyMine: c.onlyMine, onlyTheirs: c.onlyTheirs } });
      state.prompts.set(key, out);
    } catch (e) { list.innerHTML = ""; list.append(el("li", { class: "empty" }, e.message)); return; }
  }
  if (state.readerId !== r.id || !list.isConnected) return;
  list.innerHTML = "";
  out.questions.forEach((q) => list.append(el("li", {}, q)));
  note.textContent = out.source === "ai"
    ? "Written by AI from your two sets of notes. It doesn't say who's right."
    : "Built from your two sets of notes (AI is switched off).";
  // Highlights in different places that are about the same idea.
  const related = (out.related || []).map((x) => ({ ...x, m: state.mine.find((h) => h.id === x.mine), t: r.highlights.find((h) => h.id === x.theirs) })).filter((x) => x.m && x.t);
  if (!related.length || !relatedSlot) return;
  relatedSlot.append(el("div", { class: "group-label" }, "On the same idea", el("span", {}, related.length)));
  relatedSlot.append(el("div", { class: "notes" }, related.map((x) => el("div", { class: "note", onclick: () => scrollToRange(state.root, x.m.start) },
    el("div", { class: "differ", style: { color: "var(--accent)" } }, x.theme),
    el("div", { class: "who" }, el("b", {}, "You"), tagChip(x.m.tag)), el("p", { class: "quote" }, `“${shorten(x.m.quote, 140)}”`), el("p", { class: "why" }, x.m.note),
    el("div", { class: "who", style: { marginTop: "10px" } }, el("span", { style: { color: r.color, fontWeight: 600 } }, r.handle), tagChip(x.t.tag)), el("p", { class: "quote" }, `“${shorten(x.t.quote, 140)}”`), el("p", { class: "why" }, x.t.note),
    el("div", { class: "actions" }, el("button", { class: "pill small ghost", type: "button", onclick: (e) => { e.stopPropagation(); openRespond({ reader: r, h: x.t }); } }, "Respond"))))));
  relatedSlot.append(el("p", { class: "source-note" }, "Linked by AI: passages in different places about the same idea."));
}

function panelEveryone() {
  const ground = commonGround();
  const asked = state.others.flatMap((r) => (r.leftQuestions || []).map((q) => ({ r, q })));
  $panel.append(
    el("h2", {}, "Everyone"),
    el("p", { class: "hint" }, `${state.others.length + 1} readers so far, including you. The deeper the colour, the more people stopped there. Tap a passage to read their notes.`),
    el("div", { class: "legend" }, "fewer", el("span", { class: "bar" }), "more"),
    el("div", { class: "group-label" }, "Common ground"));
  if (asked.length) {
    const qs = el("div", { class: "notes" }, asked.map(({ r, q }) => el("div", { class: "note" },
      el("div", { class: "who" }, el("span", { style: { color: r.color, fontWeight: 600 } }, r.handle), r.sample ? el("span", { class: "sample" }, "sample") : null),
      el("p", { class: "why" }, q.text),
      el("div", { class: "actions" }, el("button", { class: "pill small ghost", type: "button", onclick: () => openRespond({ reader: r, mode: "answer", question: q }) }, "Answer")))));
    $panel.querySelector(".group-label:last-of-type").before(el("div", { class: "group-label" }, "Questions readers left", el("span", {}, asked.length)), qs);
  }
  if (!ground.length) { $panel.append(el("p", { class: "empty" }, "No passage has been marked by more than one reader yet.")); return; }
  $panel.append(el("div", { class: "notes" }, ground.map((g) => {
    const tags = {};
    g.items.forEach((i) => { tags[i.h.tag] = (tags[i.h.tag] || 0) + 1; });
    const uniform = Object.keys(tags).length === 1;
    const quote = g.items.reduce((a, b) => (a.h.quote.length <= b.h.quote.length ? a : b)).h.quote;
    return el("div", { class: "note", onclick: () => {
      scrollToRange(state.root, g.anchor.start);
      const keys = g.items.map((i) => (i.who === "me" ? mineKey(i.h) : otherKey(i.reader, i.h)));
      setTimeout(() => {
        const mark = [...state.root.querySelectorAll("mark.gn")].find((m) => keys.some((k) => m.dataset.keys.includes(k)));
        if (mark) openSpot(keys, mark.getBoundingClientRect());
      }, 700);
    } },
      el("p", { class: "quote" }, `“${quote}”`),
      el("div", { class: "who" }, el("b", {}, `${g.readers} readers`), uniform ? `all marked it ${tagLabel(Object.keys(tags)[0]).toLowerCase()}` : "for different reasons"),
      el("div", { class: "tagmix" }, Object.entries(tags).map(([t, n]) => el("span", { class: `tag ${t}` }, `${tagLabel(t)}${n > 1 ? ` ×${n}` : ""}`))));
  })));
}

const KIND_LABEL = { ask: "asked about", add: "added something about", answer: "answered" };

function threadCard(t) {
  const me = state.inbox.me;
  const mineStarted = t.fromId === me;
  const otherHandle = mineStarted ? t.toHandle || "a reader" : t.fromHandle;
  const card = el("div", { class: "msg" },
    el("div", { class: "meta" }, mineStarted ? `You ${KIND_LABEL[t.kind] || "asked about"} ` : `${t.fromHandle} ${KIND_LABEL[t.kind] || "asked about"} `, t.kind === "answer" ? `${mineStarted ? `${otherHandle}'s` : "your"} question ` : "", `“${shorten(t.quote, 70)}”`));
  t.messages.forEach((m, i) => card.append(el("div", { class: `bubble ${m.by === me ? "me" : "them"}` },
    el("div", { class: "meta" }, m.by === me ? "You" : otherHandle, t.helped?.includes(i) ? el("span", { class: "helped" }, " · ♥ this helped") : null),
    el("div", {}, linkify(m.text)))));
  if (t.sample) { card.append(el("p", { class: "meta" }, "Sample readers don't reply. Real readers see this under Talk.")); return card; }
  const lastByOther = t.messages.at(-1)?.by !== me;
  const lastOtherIndex = t.messages.map((m) => m.by).lastIndexOf(mineStarted ? t.toId : t.fromId);
  const actions = el("div", { class: "row" });
  if (lastOtherIndex >= 0 && !t.helped?.includes(lastOtherIndex)) actions.append(el("button", { class: "pill small ghost", type: "button", onclick: async (e) => {
    e.target.disabled = true;
    try { await api("/api/thread/helped", { method: "POST", body: { token: state.me.token, threadId: t.id } }); loadInbox(); } catch (err) { toast(err.message); }
  } }, "♥ This helped"));
  actions.append(el("span", { class: "spacer" }));
  if (lastOtherIndex >= 0) actions.append(el("button", { class: "link-btn danger", type: "button", onclick: async () => {
    if (!confirm("Hide this conversation and report it?")) return;
    try { await api("/api/thread/hide", { method: "POST", body: { token: state.me.token, threadId: t.id } }); toast("Hidden and reported."); loadInbox(); } catch (err) { toast(err.message); }
  } }, "Hide and report"));
  if (t.messages.length >= 8) { card.append(el("p", { class: "meta" }, "This conversation has reached its limit."), actions); return card; }
  if (!state.ai) { card.append(el("p", { class: "meta" }, "Replying needs the AI kindness check, which is switched off."), actions); return card; }
  const ta = el("textarea", { placeholder: lastByOther ? "Reply…" : "Add more…", maxlength: "600", "data-tid": t.id });
  const heldSlot = el("div");
  const send = el("button", { class: "pill small", type: "button" }, "Send");
  send.addEventListener("click", async () => {
    if (ta.value.trim().length < 2) return ta.focus();
    send.disabled = true; send.textContent = "Checking…";
    heldSlot.innerHTML = "";
    try { await api("/api/thread/reply", { method: "POST", body: { token: state.me.token, threadId: t.id, text: ta.value } }); ta.value = ""; loadInbox(); }
    catch (e) {
      if (e.data?.held) heldSlot.append(heldBox(e.data.held, (v) => { ta.value = v; }));
      else toast(e.message);
      send.disabled = false; send.textContent = "Send";
    }
  });
  card.append(ta, heldSlot, el("div", { class: "row" }, send), actions);
  return card;
}

function panelInbox() {
  const threads = state.inbox.threads;
  markSeen();
  $panel.append(el("h2", {}, "Talk"), el("p", { class: "hint" }, "Your conversations with other readers about this article. New messages show up every 20 seconds."));
  if (!threads.length) { $panel.append(el("p", { class: "empty" }, "No conversations yet. Respond to something another reader marked, or answer a question they left.")); return; }
  threads.forEach((t) => $panel.append(threadCard(t)));
}

start();
