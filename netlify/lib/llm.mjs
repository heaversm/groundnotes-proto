// The LLM jobs, each with a fallback that needs no model:
//   reflect() - two questions to think about before seeing anyone else, drawn from your own notes
//   prompts() - things two readers could talk about, plus highlights that are about the same idea
//   suggest() - three different questions to ask about another reader's note
//   check()   - is a message to another reader kind enough to deliver? If not, kinder versions
// The key comes from ANTHROPIC_API_KEY in the environment (.env locally, Netlify settings when deployed).
import Anthropic from "@anthropic-ai/sdk";

const MODEL = process.env.GROUND_NOTES_MODEL || "claude-opus-5-5";
const TAG_WORDS = { observation: "an observation", question: "a question", followup: "something to follow up", disagree: "a disagreement", remember: "something to remember" };

let client = null;
const ready = () => Boolean(process.env.ANTHROPIC_API_KEY);
function anthropic() {
  if (!client) client = new Anthropic();
  return client;
}

// One structured-output call. Returns the parsed object, or null if anything goes wrong.
async function ask({ system, user, schema, noAI }) {
  if (!ready() || noAI) return null;
  try {
    const response = await anthropic().beta.messages.create({
      model: MODEL,
      max_tokens: 4000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low", format: { type: "json_schema", schema } },
      system,
      messages: [{ role: "user", content: user }],
    });
    if (response.stop_reason === "refusal") return null;
    const block = response.content.find((b) => b.type === "text");
    return block ? JSON.parse(block.text) : null;
  } catch (e) {
    console.error("LLM call failed:", e?.status ?? "", e?.message ?? e);
    return null;
  }
}

const short = (s, n = 90) => (s.length > n ? `${s.slice(0, n).trimEnd()}…` : s);
const strings = (list, n) => (Array.isArray(list) ? list.map((v) => String(v).trim()).filter(Boolean).slice(0, n) : []);
const line = (h) => `- [${h.id}] "${short(h.quote, 200)}" (${TAG_WORDS[h.tag] || h.tag}): ${h.note}`;
const LIST_SCHEMA = (key) => ({ type: "object", properties: { [key]: { type: "array", items: { type: "string" } } }, required: [key], additionalProperties: false });

// --- reflect ---

const REFLECT_SYSTEM = `A reader has just finished an article and left highlights with notes. Before they see what anyone else noticed, ask them two short questions to reflect on.
Rules:
- Ground each question in their own notes: name the idea they marked, in a few words.
- One question about what surprised them or changed for them; one about what they'd still want to know or ask someone.
- Never summarise the article, add facts, or give an opinion.
- Plain words, one sentence each, under 25 words.`;

export async function reflect({ title, mine, noAI }) {
  const out = await ask({ noAI, system: REFLECT_SYSTEM, user: `Article: ${title}\n\nTheir highlights:\n${mine.map(line).join("\n")}`, schema: LIST_SCHEMA("questions") });
  const questions = strings(out?.questions, 2);
  if (questions.length) return { questions, source: "ai" };
  return { questions: ["What surprised you most in this piece?", "What would you want to ask someone else who read it?"], source: "templates" };
}

// --- prompts + related ---

const PROMPTS_SYSTEM = `Two anonymous readers each highlighted passages of the same article, tagged each one, and wrote why it stood out.
Return:
- "questions": three or four short questions they could talk about together. Draw on where they marked the same passage for different reasons, and what only one of them noticed. Address them as "you both", "one of you", "the other". Never say who is right. Never summarise the article, add facts, or give an opinion. One sentence each, under 30 words.
- "related": pairs of highlights, one from each reader, that are about the same idea even though they're in different parts of the article. Use the ids in square brackets. "theme" names the shared idea in two to five plain words. Only include real connections; an empty list is fine.`;

const PROMPTS_SCHEMA = {
  type: "object",
  properties: {
    questions: { type: "array", items: { type: "string" } },
    related: {
      type: "array",
      items: {
        type: "object",
        properties: { mine: { type: "string" }, theirs: { type: "string" }, theme: { type: "string" } },
        required: ["mine", "theirs", "theme"],
        additionalProperties: false,
      },
    },
  },
  required: ["questions", "related"],
  additionalProperties: false,
};

export async function prompts({ title, shared, onlyMine, onlyTheirs, noAI }) {
  const user = [
    `Article: ${title}`,
    `Passages they both marked:\n${shared.map((s) => `- "${short(s.quote, 200)}" — reader A: ${TAG_WORDS[s.mine.tag]}, "${s.mine.note}"; reader B: ${TAG_WORDS[s.theirs.tag]}, "${s.theirs.note}"`).join("\n") || "(none)"}`,
    `Only reader A marked:\n${onlyMine.map(line).join("\n") || "(none)"}`,
    `Only reader B marked:\n${onlyTheirs.map(line).join("\n") || "(none)"}`,
  ].join("\n\n");
  const out = await ask({ noAI, system: PROMPTS_SYSTEM, user, schema: PROMPTS_SCHEMA });
  const questions = strings(out?.questions, 4);
  const mineIds = new Set(onlyMine.map((h) => h.id));
  const theirIds = new Set(onlyTheirs.map((h) => h.id));
  const related = (out?.related || []).filter((r) => mineIds.has(r.mine) && theirIds.has(r.theirs)).slice(0, 4);
  if (questions.length) return { questions, related, source: "ai" };

  // Fallback: questions straight from the comparison, no related pairs.
  const qs = [];
  const differ = shared.find((s) => s.mine.tag !== s.theirs.tag);
  if (differ) qs.push(`You both marked "${short(differ.quote, 70)}" — one as ${TAG_WORDS[differ.mine.tag]}, one as ${TAG_WORDS[differ.theirs.tag]}. What did each of you see there?`);
  const same = shared.find((s) => s.mine.tag === s.theirs.tag);
  if (same) qs.push(`You both marked "${short(same.quote, 70)}" as ${TAG_WORDS[same.mine.tag]}. Did you see the same thing in it?`);
  if (onlyTheirs[0]) qs.push(`The other reader noticed "${short(onlyTheirs[0].quote, 70)}" and you didn't. Does it change how you read the rest?`);
  if (onlyMine[0]) qs.push(`Only you marked "${short(onlyMine[0].quote, 70)}". What drew you to it?`);
  if (!qs.length) qs.push("What's one thing from this article you'd bring up with a friend?");
  return { questions: qs.slice(0, 4), related: [], source: "templates" };
}

// --- suggest ---

const SUGGEST_SYSTEM = `You help one anonymous reader ask another about a passage the other reader highlighted in an article.
Offer three genuinely different questions, not three phrasings of one question:
- One about the other reader's reasons or experience behind their note.
- One that takes it somewhere new: what they'd want to find out next, what would change their mind, or how it connects to something else.
- One that is concrete and specific to the passage itself.
If the asker wrote a draft, make the first question the asker's own question, kept close to what they meant but clear and kind, and use the other two for different angles.
Rules: ask about their thinking; never argue, correct, or hint they're wrong; never add your own opinion or facts. Plain words, one sentence each, under 30 words.`;

export async function suggest({ draft, quote, note, presets, noAI }) {
  const user = `Passage they highlighted: "${quote}"\nTheir note: "${note}"${draft ? `\nThe asker's draft: "${draft}"` : ""}`;
  const out = await ask({ noAI, system: SUGGEST_SYSTEM, user, schema: LIST_SCHEMA("questions") });
  const questions = strings(out?.questions, 3);
  if (questions.length) return { questions, source: "ai" };
  return { questions: presets, source: "templates" };
}

// --- check ---

const CHECK_SYSTEM = `You check messages one anonymous reader is about to send another, in a small reading community built to be kind and curious.
Deliver ("ok": true) anything respectful: questions, honest disagreement stated with care, extra context, personal experience, and links to sources.
Hold back ("ok": false) messages that insult, mock, belittle or attack the person; sarcasm aimed at them; harassment; slurs; requests for or sharing of personal details; spam or advertising.
When you hold one back:
- "reason": one short, kind sentence telling the sender why, without lecturing.
- "suggestions": up to three rewrites that keep what the sender actually wanted to say or ask (and any links), phrased kindly.
When "ok" is true, "reason" is "" and "suggestions" is [].`;

const CHECK_SCHEMA = {
  type: "object",
  properties: { ok: { type: "boolean" }, reason: { type: "string" }, suggestions: { type: "array", items: { type: "string" } } },
  required: ["ok", "reason", "suggestions"],
  additionalProperties: false,
};

export async function check({ text, situation, quote, previous, article }) {
  const user = [
    `Situation: ${situation}`,
    article ? `Article: ${article}` : null,
    quote ? `Passage being discussed: "${short(quote, 300)}"` : null,
    previous ? `Message being replied to: "${short(previous, 300)}"` : null,
    `Message to check: "${text}"`,
  ].filter(Boolean).join("\n");
  const out = await ask({ system: CHECK_SYSTEM, user, schema: CHECK_SCHEMA });
  // If the check itself fails, don't deliver unchecked text.
  if (!out) return { ok: false, reason: "The kindness check isn't responding right now, so this couldn't be sent. Try again, or pick a ready-made question.", suggestions: [] };
  return { ok: Boolean(out.ok), reason: String(out.reason || ""), suggestions: strings(out.suggestions, 3) };
}

export const aiReady = ready;
