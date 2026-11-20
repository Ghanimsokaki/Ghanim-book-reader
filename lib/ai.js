// AI reading assistant and bedtime-story writer, powered by Claude.
import Anthropic from "@anthropic-ai/sdk";
import { readJsonBody, sendJson, startEventStream } from "./http.js";

export const MODEL = process.env.AI_MODEL || "claude-opus-5-5";
const hasKey = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
export const anthropic = hasKey ? new Anthropic() : null;

const NOT_SET_UP = "The AI assistant is not set up. Add an ANTHROPIC_API_KEY environment variable to turn it on.";

const ASSISTANT_PROMPT = `You are a friendly reading companion inside an ebook reader app that is often used to read bedtime stories to children.
The reader shares a passage from the book they are reading. Help them understand and enjoy it.
Keep answers clear and easy to read aloud: plain sentences, no markdown, no tables, no bullet symbols.
Base your answer on the passage provided; if the question goes beyond it, say what you know about the book in general and say so.
Do not spoil later parts of the book unless the reader explicitly asks.`;

const ACTIONS = {
  summarize: () => "Summarize this passage in a short paragraph, then give the 3 most important points as short sentences.",
  explain: () =>
    "Explain this passage in simple, everyday language, as if to a curious 7-year-old. Explain any old-fashioned or difficult words.",
  characters: () => "Who are the people or characters in this passage, and what is each of them doing or feeling?",
  vocab: () => "Pick up to 8 difficult or unusual words from this passage and give a short, simple definition for each.",
  retell: () =>
    "Retell this passage as a gentle bedtime story for a young child (about 4 to 7 years old). Keep the events, use simple words and short sentences, soften anything scary, and keep a calm, cozy tone. Only output the story itself, ready to be read aloud.",
  ask: (q) => q,
};

const STORY_PROMPT = `You write original bedtime stories for children, to be read aloud at night.
Every story is gentle, warm and calming: no violence, no real danger, nothing scary or sad that is left unresolved.
Use vivid but soft imagery, a little gentle humor, and simple words that suit the child's age.
Let the pace slow down toward the end, with quieter sentences, and finish with the main character safe, cozy and drifting off to sleep.
Write plain text for reading aloud: no markdown, no headings, no lists, no emoji.
The first line must be "Title: " followed by a short title. Then a blank line, then the story in short paragraphs separated by blank lines.`;

const LENGTHS = { short: 350, medium: 700, long: 1200 };
const AGES = { "3-5": "3 to 5", "6-8": "6 to 8", "9-12": "9 to 12" };

function aiErrorMessage(err) {
  if (err instanceof Anthropic.AuthenticationError) return "The AI API key is invalid.";
  if (err instanceof Anthropic.RateLimitError) return "The AI assistant is busy. Wait a moment and try again.";
  if (err instanceof Anthropic.APIError) return `AI error: ${err.message}`;
  return "The AI assistant ran into a problem. Please try again.";
}

// Streams a Claude response to the browser as server-sent events: {text} chunks, then {done} or {error}.
async function streamToClient(req, res, params) {
  const send = startEventStream(res);
  const controller = new AbortController();
  res.on("close", () => controller.abort());
  try {
    const stream = anthropic.beta.messages.stream(
      {
        model: MODEL,
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default", // if the main model declines, the API retries on a fallback model
        ...params,
      },
      { signal: controller.signal },
    );
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        send({ text: event.delta.text });
      }
    }
    const final = await stream.finalMessage();
    if (final.stop_reason === "refusal") send({ error: "The assistant could not help with this request." });
    send({ done: true });
  } catch (err) {
    if (!controller.signal.aborted) {
      console.error("AI error:", err);
      send({ error: aiErrorMessage(err) });
    }
  } finally {
    res.end();
  }
}

export async function handleAssistant(req, res) {
  if (!anthropic) return sendJson(req, res, 503, { error: NOT_SET_UP });
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(req, res, 400, { error: "Invalid request" });
  }
  const action = ACTIONS[body.action] ? body.action : "ask";
  const question = String(body.question || "").slice(0, 2000).trim();
  if (action === "ask" && !question) return sendJson(req, res, 400, { error: "Please type a question." });
  const passage = String(body.text || "").slice(0, 60_000);
  const title = String(body.title || "Unknown book").slice(0, 300);
  const author = String(body.author || "").slice(0, 300);

  const messages = [];
  for (const turn of Array.isArray(body.history) ? body.history.slice(-10) : []) {
    if ((turn.role === "user" || turn.role === "assistant") && typeof turn.content === "string" && turn.content) {
      messages.push({ role: turn.role, content: turn.content.slice(0, 8000) });
    }
  }
  // Messages must alternate and start with the user.
  while (messages.length && messages[0].role !== "user") messages.shift();
  if (messages.length && messages[messages.length - 1].role === "user") messages.pop();
  messages.push({
    role: "user",
    content: `Book: "${title}"${author ? ` by ${author}` : ""}\n\n<passage>\n${passage}\n</passage>\n\n${ACTIONS[action](question)}`,
  });

  await streamToClient(req, res, { system: ASSISTANT_PROMPT, messages, output_config: { effort: "medium" } });
}

export async function handleStory(req, res) {
  if (!anthropic) return sendJson(req, res, 503, { error: NOT_SET_UP });
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(req, res, 400, { error: "Invalid request" });
  }
  const name = String(body.name || "").replace(/\s+/g, " ").trim().slice(0, 40);
  const about = String(body.about || "").replace(/\s+/g, " ").trim().slice(0, 300);
  const words = LENGTHS[body.length] || LENGTHS.medium;
  const age = AGES[body.age] || AGES["3-5"];

  const request = [
    `Please write a new bedtime story for a child aged ${age}.`,
    name ? `The child's name is ${name}; make them the main character or a close friend of the main character.` : "",
    about ? `The story should be about: ${about}` : "Choose a cozy, imaginative topic yourself.",
    `Aim for about ${words} words.`,
  ]
    .filter(Boolean)
    .join("\n");

  await streamToClient(req, res, {
    system: STORY_PROMPT,
    messages: [{ role: "user", content: request }],
    output_config: { effort: "low" },
  });
}
