// Ground Notes server: articles, readings, conversations and the LLM helpers.
//   GET  /api/status                    whether the LLM is switched on, and the ready-made questions
//   GET  /api/article?url=…             the article in reader form (extracted once, then cached)
//   GET  /api/readings?article=…        everyone's readings, only once you've shared your own (send x-reader-token)
//   POST /api/reading                   share or update your reading { articleId, highlights, readTo, reflections, leftQuestions, token? }
//   POST /api/suggest                   three different questions to ask about a note { quote, note, text? }
//   POST /api/reflect                   two questions to reflect on, drawn from your own notes { title, mine }
//   POST /api/prompts                   things to talk about + highlights on the same idea, for two readings
//   POST /api/thread                    start a conversation { token, articleId, toReadingId, kind, highlightId, quote, text, preset? }
//   POST /api/thread/reply              add to a conversation { token, threadId, text }
//   POST /api/thread/helped             mark the other person's last message as helpful { token, threadId }
//   POST /api/thread/hide               hide a conversation and report it { token, threadId }
//   GET  /api/inbox?article=…           your conversations (send x-reader-token)
// Anything a person writes to another person is checked by the LLM before it's delivered.
// Errors come back as 200 with { error }: Netlify's dev server swaps a function's 4xx for its own 404 page.
import { getStore } from "@netlify/blobs";
import { extract, normalizeUrl, articleId } from "../lib/extract.mjs";
import { prompts, reflect, check, suggest, aiReady } from "../lib/llm.mjs";
import seeds from "../lib/seeds.json" with { type: "json" };

const TAGS = new Set(["observation", "question", "followup", "disagree", "remember"]);
const KINDS = new Set(["ask", "add", "answer"]);
const MAX_HIGHLIGHTS = 60;
const MAX_NOTE = 1200;
const MAX_QUOTE = 2000;
const MAX_MESSAGES = 8; // a conversation, not a thread that runs forever
const MAX_LEFT = 2; // questions a reader can leave for the next reader
const AI_PER_HOUR = 40; // AI calls per visitor address per hour; over it, features fall back to ready-made text

// Ready-made questions need no check. Kept here so the server can tell them apart from free text.
const PRESETS = [
  "What made this passage stand out to you?",
  "Did something you knew before reading shape how you saw this part?",
  "What would you want to find out next about this?",
];

const store = (name) => getStore({ name, consistency: "strong" });
const json = (body) => Response.json(body, { headers: { "cache-control": "no-store" } });
const fail = (error, extra = {}) => json({ error, ...extra });
const rid = () => crypto.randomUUID().replace(/-/g, "").slice(0, 16);
const text = (s, max) => String(s ?? "").trim().slice(0, max);

async function sha(s) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const ADJ = ["amber", "quiet", "bright", "gentle", "curious", "patient", "wandering", "steady", "early", "silver", "mossy", "golden", "careful", "open", "rainy", "sunlit", "tidal", "northern", "warm", "lucky"];
const NOUN = ["heron", "otter", "lantern", "maple", "sparrow", "harbor", "comet", "fern", "badger", "willow", "kite", "pebble", "meadow", "finch", "orchard", "river", "moth", "cedar", "wren", "tide"];
const handle = () => `${ADJ[Math.floor(Math.random() * ADJ.length)]} ${NOUN[Math.floor(Math.random() * NOUN.length)]}`;

// A light cap per visitor address on anything that calls the LLM, so a public link can't run up the bill.
let requestIp = "unknown";
async function aiAllowed() {
  const limits = store("limits");
  const key = `${String(requestIp).replace(/[^A-Za-z0-9:._-]/g, "").slice(0, 64) || "unknown"}-${Math.floor(Date.now() / 3_600_000)}`;
  const count = Number((await limits.get(key)) ?? 0);
  if (count >= AI_PER_HOUR) return false;
  await limits.set(key, String(count + 1));
  return true;
}

// Links in messages: only http(s), at most two.
function links(s) {
  return (s.match(/https?:\/\/[^\s<>"')]+/g) || []).slice(0, 2);
}

// Free text to another person goes through the check; ready-made questions don't.
async function screen(message, context) {
  if (PRESETS.includes(message)) return { ok: true };
  if (!aiReady()) return { ok: false, reason: "Writing your own message needs the AI check, which is switched off. Pick a ready-made question instead.", suggestions: [] };
  if (!(await aiAllowed())) return { ok: false, reason: "You've sent a lot this hour, so the kindness check is resting. Pick a ready-made question, or try again later.", suggestions: [] };
  return check({ text: message, ...context });
}

// --- articles ---

async function getArticle(url) {
  const raw = url.searchParams.get("url") || "";
  let normalized;
  try {
    normalized = normalizeUrl(raw);
    if (!/^https?:/.test(normalized)) throw new Error();
  } catch {
    return fail("That doesn't look like a web address.");
  }
  const id = await articleId(normalized);
  const articles = store("articles");
  let article = await articles.get(id, { type: "json" });
  if (!article) {
    try {
      article = await extract(raw);
    } catch (e) {
      return fail(`Couldn't read that page. ${e.message}.`);
    }
    await articles.setJSON(id, article);
  }
  return json({ article });
}

// --- readings ---

function cleanHighlights(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, MAX_HIGHLIGHTS).map((h) => ({
    id: text(h.id, 24) || rid(),
    quote: text(h.quote, MAX_QUOTE),
    prefix: String(h.prefix ?? "").slice(0, 64),
    suffix: String(h.suffix ?? "").slice(0, 64),
    start: Number.isInteger(h.start) ? h.start : null,
    end: Number.isInteger(h.end) ? h.end : null,
    tag: TAGS.has(h.tag) ? h.tag : "observation",
    note: text(h.note, MAX_NOTE),
    at: Number(h.at) || Date.now(),
  })).filter((h) => h.quote && h.note);
}

function cleanReflections(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 3).map((r) => ({ prompt: text(r.prompt, 300), answer: text(r.answer, 800) })).filter((r) => r.prompt && r.answer);
}

// The reading that belongs to a token, if any.
async function readingForToken(articleIdValue, token) {
  if (!token || !articleIdValue) return null;
  const readingId = await store("tokens").get(`${articleIdValue}/${await sha(token)}`);
  if (!readingId) return null;
  return store("readings").get(`${articleIdValue}/${readingId}`, { type: "json" });
}

async function saveReading(req) {
  const body = await req.json().catch(() => ({}));
  const aid = text(body.articleId, 32);
  const article = aid && (await store("articles").get(aid, { type: "json" }));
  if (!article) return fail("Unknown article.");
  const highlights = cleanHighlights(body.highlights);
  if (!highlights.length) return fail("Add at least one highlight with a note first.");

  const readings = store("readings");
  let reading = body.token ? await readingForToken(aid, body.token) : null;
  let token = body.token;
  const isNew = !reading;
  if (isNew) reading = { id: rid(), articleId: aid, handle: handle(), createdAt: Date.now() };

  // Questions left for the next reader are addressed to people, so they're checked.
  if (Array.isArray(body.leftQuestions)) {
    const left = [];
    for (const q of body.leftQuestions.slice(0, MAX_LEFT)) {
      const t = text(q.text, 300);
      if (t.length < 5) continue;
      const known = (reading.leftQuestions || []).find((x) => x.text === t);
      if (known) { left.push(known); continue; }
      const verdict = await screen(t, { situation: "a question left for whoever reads this article next", article: article.title });
      if (!verdict.ok) return fail("One of your questions for the next reader was held back.", { held: { text: t, reason: verdict.reason, suggestions: verdict.suggestions } });
      left.push({ id: rid(), text: t });
    }
    reading.leftQuestions = left;
  }
  if (Array.isArray(body.reflections)) reading.reflections = cleanReflections(body.reflections);

  if (isNew) {
    token = crypto.randomUUID();
    await store("tokens").set(`${aid}/${await sha(token)}`, reading.id);
  }
  reading.highlights = highlights;
  const readTo = Number(body.readTo);
  if (Number.isFinite(readTo)) reading.readTo = Math.max(reading.readTo ?? 0, Math.min(1, Math.max(0, readTo)));
  reading.updatedAt = Date.now();
  await readings.setJSON(`${aid}/${reading.id}`, reading);
  return json({ readingId: reading.id, handle: reading.handle, token, leftQuestions: reading.leftQuestions || [] });
}

async function seedReadings(aid) {
  const out = [];
  for (const seed of seeds) {
    if ((await articleId(normalizeUrl(seed.url))) !== aid) continue;
    for (const r of seed.readers) {
      out.push({
        id: `sample-${r.handle.replace(/\s+/g, "-")}`, handle: r.handle, sample: true,
        highlights: r.highlights.map((h, i) => ({ id: `s${i}`, ...h })),
        reflections: r.reflections || [], leftQuestions: (r.leftQuestions || []).map((t, i) => ({ id: `sq${i}`, text: t })), readTo: null,
      });
    }
  }
  return out;
}

async function listReadings(req, url) {
  const aid = text(url.searchParams.get("article"), 32);
  const mine = await readingForToken(aid, req.headers.get("x-reader-token"));
  const readings = store("readings");
  const { blobs } = await readings.list({ prefix: `${aid}/` });
  const samples = await seedReadings(aid);
  // Write before you see: nothing but a count until you've shared.
  if (!mine) return json({ locked: true, count: blobs.length + samples.length });
  const all = await Promise.all(blobs.map(({ key }) => readings.get(key, { type: "json" })));
  const others = all.filter((r) => r && r.id !== mine.id).map((r) => ({
    id: r.id, handle: r.handle, highlights: r.highlights, readTo: r.readTo ?? null,
    reflections: r.reflections || [], leftQuestions: r.leftQuestions || [], createdAt: r.createdAt,
  }));
  return json({ locked: false, mine: { id: mine.id, handle: mine.handle, leftQuestions: mine.leftQuestions || [], reflections: mine.reflections || [] }, readings: [...others, ...samples] });
}

// --- conversations ---

const threads = () => store("questions"); // the store keeps its first name so earlier test data still loads

// Earlier versions stored one question and one reply; show those as a two-message conversation.
function upgrade(t) {
  if (!t || t.messages) return t;
  const messages = [{ by: t.fromId, handle: t.fromHandle, text: t.text, at: t.createdAt }];
  if (t.reply) messages.push({ by: t.toId, handle: null, text: t.reply.text, at: t.reply.at });
  return { ...t, kind: "ask", messages, helped: [], hiddenBy: [] };
}

async function loadThread(id) {
  return upgrade(await threads().get(`q/${text(id, 24)}`, { type: "json" }));
}

async function startThread(req) {
  const body = await req.json().catch(() => ({}));
  const aid = text(body.articleId, 32);
  const from = await readingForToken(aid, body.token);
  if (!from) return fail("Share your own reading first.");
  const message = text(body.text, 600);
  if (message.length < 3) return fail("The message is empty.");
  const kind = KINDS.has(body.kind) ? body.kind : "ask";
  const toId = text(body.toReadingId, 64);
  const sample = toId.startsWith("sample-");
  let to = null;
  if (!sample) {
    to = await store("readings").get(`${aid}/${toId}`, { type: "json" });
    if (!to) return fail("That reader isn't here any more.");
  }
  const quote = text(body.quote, 400);
  const verdict = await screen(message, { situation: kind === "add" ? "sharing something useful with another reader" : kind === "answer" ? "answering a question another reader left" : "asking another reader about their note", quote });
  if (!verdict.ok) return fail("Held back", { held: { text: message, reason: verdict.reason, suggestions: verdict.suggestions } });

  const now = Date.now();
  const thread = {
    id: rid(), articleId: aid, kind, fromId: from.id, fromHandle: from.handle, toId, toHandle: to?.handle ?? text(body.toHandle, 40),
    highlightId: text(body.highlightId, 24), quote, sample, createdAt: now, updatedAt: now,
    messages: [{ by: from.id, handle: from.handle, text: message, links: links(message), at: now }],
    helped: [], hiddenBy: [], reports: [],
  };
  const qs = threads();
  await qs.setJSON(`q/${thread.id}`, thread);
  await qs.set(`to/${aid}/${toId}/${thread.id}`, "1");
  await qs.set(`from/${aid}/${from.id}/${thread.id}`, "1");
  return json({ thread });
}

async function replyThread(req) {
  const body = await req.json().catch(() => ({}));
  const thread = await loadThread(body.threadId);
  if (!thread) return fail("Conversation not found.");
  const me = await readingForToken(thread.articleId, body.token);
  if (!me || (me.id !== thread.fromId && me.id !== thread.toId)) return fail("Only the two readers in this conversation can write in it.");
  if (thread.messages.length >= MAX_MESSAGES) return fail("This conversation has reached its limit.");
  const message = text(body.text, 600);
  if (message.length < 2) return fail("The message is empty.");
  const verdict = await screen(message, { situation: "replying in a conversation with another reader", quote: thread.quote, previous: thread.messages.at(-1)?.text });
  if (!verdict.ok) return fail("Held back", { held: { text: message, reason: verdict.reason, suggestions: verdict.suggestions } });
  thread.messages.push({ by: me.id, handle: me.handle, text: message, links: links(message), at: Date.now() });
  thread.updatedAt = Date.now();
  await threads().setJSON(`q/${thread.id}`, thread);
  return json({ thread });
}

async function helpedThread(req) {
  const body = await req.json().catch(() => ({}));
  const thread = await loadThread(body.threadId);
  if (!thread) return fail("Conversation not found.");
  const me = await readingForToken(thread.articleId, body.token);
  if (!me || (me.id !== thread.fromId && me.id !== thread.toId)) return fail("Not your conversation.");
  // The latest message from the other person is the one that helped.
  const index = thread.messages.map((m) => m.by).lastIndexOf(me.id === thread.fromId ? thread.toId : thread.fromId);
  if (index < 0) return fail("Nothing to mark yet.");
  if (!thread.helped.includes(index)) thread.helped.push(index);
  await threads().setJSON(`q/${thread.id}`, thread);
  return json({ thread });
}

async function hideThread(req) {
  const body = await req.json().catch(() => ({}));
  const thread = await loadThread(body.threadId);
  if (!thread) return fail("Conversation not found.");
  const me = await readingForToken(thread.articleId, body.token);
  if (!me || (me.id !== thread.fromId && me.id !== thread.toId)) return fail("Not your conversation.");
  if (!thread.hiddenBy.includes(me.id)) thread.hiddenBy.push(me.id);
  thread.reports = [...(thread.reports || []), { by: me.id, at: Date.now() }];
  await threads().setJSON(`q/${thread.id}`, thread);
  return json({ ok: true });
}

async function inbox(req, url) {
  const aid = text(url.searchParams.get("article"), 32);
  const me = await readingForToken(aid, req.headers.get("x-reader-token"));
  if (!me) return json({ threads: [] });
  const qs = threads();
  const ids = new Set();
  for (const prefix of [`to/${aid}/${me.id}/`, `from/${aid}/${me.id}/`]) {
    const { blobs } = await qs.list({ prefix });
    blobs.forEach(({ key }) => ids.add(key.split("/").pop()));
  }
  const all = (await Promise.all([...ids].map(loadThread))).filter((t) => t && !t.hiddenBy.includes(me.id));
  all.sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
  return json({ me: me.id, threads: all.map(({ reports, ...t }) => t) });
}

// --- LLM helpers ---

const pickHighlights = (list, n = 20) => (Array.isArray(list) ? list.slice(0, n).map((h) => ({ id: text(h?.id, 24), quote: text(h?.quote, 400), tag: TAGS.has(h?.tag) ? h.tag : "observation", note: text(h?.note, 400) })) : []);

async function suggestRoute(req) {
  const body = await req.json().catch(() => ({}));
  return json(await suggest({ draft: text(body.text, 400), quote: text(body.quote, 600), note: text(body.note, 600), presets: PRESETS, noAI: !(await aiAllowed()) }));
}

async function reflectRoute(req) {
  const body = await req.json().catch(() => ({}));
  return json(await reflect({ title: text(body.title, 200), mine: pickHighlights(body.mine), noAI: !(await aiAllowed()) }));
}

async function promptsRoute(req) {
  const body = await req.json().catch(() => ({}));
  const one = (h) => ({ quote: text(h?.quote, 400), tag: TAGS.has(h?.tag) ? h.tag : "observation", note: text(h?.note, 400) });
  const shared = Array.isArray(body.shared) ? body.shared.slice(0, 20).map((s) => ({ quote: text(s.quote, 400), mine: one(s.mine), theirs: one(s.theirs) })) : [];
  return json(await prompts({ title: text(body.title, 200), shared, onlyMine: pickHighlights(body.onlyMine), onlyTheirs: pickHighlights(body.onlyTheirs), noAI: !(await aiAllowed()) }));
}

export default async (req, context) => {
  requestIp = context?.ip || req.headers.get("x-nf-client-connection-ip") || "unknown";
  const url = new URL(req.url);
  const route = `${req.method} ${url.pathname}`;
  try {
    switch (route) {
      case "GET /api/status": return json({ ai: aiReady(), presets: PRESETS });
      case "GET /api/article": return await getArticle(url);
      case "GET /api/readings": return await listReadings(req, url);
      case "POST /api/reading": return await saveReading(req);
      case "POST /api/reflect": return await reflectRoute(req);
      case "POST /api/suggest": return await suggestRoute(req);
      case "POST /api/prompts": return await promptsRoute(req);
      case "POST /api/thread": return await startThread(req);
      case "POST /api/thread/reply": return await replyThread(req);
      case "POST /api/thread/helped": return await helpedThread(req);
      case "POST /api/thread/hide": return await hideThread(req);
      case "GET /api/inbox": return await inbox(req, url);
      default: return fail("Not found.");
    }
  } catch (e) {
    console.error(e);
    return fail(String(e?.message ?? e));
  }
};

export const config = { path: "/api/*" };
