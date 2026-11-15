// Ghanim Book Reader - small Node server.
//  - Serves the web app in ./public
//  - /api/search      -> searches free public-domain ebooks (Project Gutenberg via the Gutendex API)
//  - /api/book/:id    -> downloads a book's plain text and strips the Gutenberg boilerplate
//  - /api/ai          -> streams an AI reading assistant answer (Claude) about the text you're reading
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(here, "public");
const PORT = Number(process.env.PORT) || 3000;
const GUTENDEX = process.env.GUTENDEX_URL || "https://gutendex.com/books";
const MODEL = process.env.AI_MODEL || "claude-opus-5-5";

const hasAiKey = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
const anthropic = hasAiKey ? new Anthropic() : null;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
};

// Small in-memory caches so repeated opens are instant.
const bookCache = new Map(); // id -> { meta, text }
const searchCache = new Map(); // url -> json

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

async function readBody(req, limit = 2_000_000) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("Request too large"), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function simplifyBook(b) {
  const f = b.formats || {};
  return {
    id: b.id,
    title: b.title,
    authors: (b.authors || []).map((a) => a.name),
    subjects: (b.subjects || []).slice(0, 4),
    languages: b.languages || [],
    downloads: b.download_count || 0,
    cover: f["image/jpeg"] || null,
  };
}

async function fetchJson(url) {
  if (searchCache.has(url)) return searchCache.get(url);
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) throw Object.assign(new Error(`Book catalog returned ${r.status}`), { status: 502 });
  const data = await r.json();
  searchCache.set(url, data);
  if (searchCache.size > 200) searchCache.delete(searchCache.keys().next().value);
  return data;
}

async function handleSearch(url, res) {
  const q = (url.searchParams.get("q") || "").trim();
  const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
  const lang = (url.searchParams.get("lang") || "").trim();
  const topic = (url.searchParams.get("topic") || "").trim();
  const api = new URL(GUTENDEX);
  if (q) api.searchParams.set("search", q);
  if (lang) api.searchParams.set("languages", lang);
  if (topic) api.searchParams.set("topic", topic);
  if (page > 1) api.searchParams.set("page", String(page));
  api.searchParams.set("mime_type", "text/");
  const data = await fetchJson(api.toString());
  sendJson(res, 200, {
    count: data.count,
    page,
    hasNext: Boolean(data.next),
    results: (data.results || []).map(simplifyBook),
  });
}

function pickTextUrl(formats, id) {
  const entries = Object.entries(formats || {});
  const plain = entries.filter(([k, v]) => k.startsWith("text/plain") && !v.endsWith(".zip"));
  const utf8 = plain.find(([k]) => k.includes("utf-8"));
  if (utf8) return { url: utf8[1], html: false };
  if (plain.length) return { url: plain[0][1], html: false };
  const html = entries.find(([k, v]) => k.startsWith("text/html") && !v.endsWith(".zip"));
  if (html) return { url: html[1], html: true };
  return { url: `https://www.gutenberg.org/cache/epub/${id}/pg${id}.txt`, html: false };
}

function stripHtml(html) {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/(p|div|h[1-6]|li|br)>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function cleanGutenbergText(raw) {
  let text = raw.replace(/\r\n?/g, "\n");
  const start = text.search(/\*\*\*\s*START OF (THE|THIS) PROJECT GUTENBERG[^\n]*\n/i);
  if (start !== -1) text = text.slice(text.indexOf("\n", start) + 1);
  const end = text.search(/\*\*\*\s*END OF (THE|THIS) PROJECT GUTENBERG/i);
  if (end !== -1) text = text.slice(0, end);
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

async function handleBook(id, res) {
  if (!/^\d+$/.test(id)) return sendJson(res, 400, { error: "Invalid book id" });
  if (bookCache.has(id)) return sendJson(res, 200, bookCache.get(id));

  const meta = await fetchJson(`${GUTENDEX}/${id}`);
  const { url, html } = pickTextUrl(meta.formats, id);
  const host = new URL(url).hostname;
  if (!host.endsWith("gutenberg.org")) return sendJson(res, 400, { error: "Unsupported source" });

  const r = await fetch(url);
  if (!r.ok) return sendJson(res, 502, { error: `Could not download the book (${r.status})` });
  let raw = await r.text();
  if (html) raw = stripHtml(raw);

  const book = { meta: simplifyBook(meta), text: cleanGutenbergText(raw) };
  bookCache.set(id, book);
  if (bookCache.size > 30) bookCache.delete(bookCache.keys().next().value);
  sendJson(res, 200, book);
}

const SYSTEM_PROMPT = `You are a friendly reading companion inside an ebook reader app.
The reader shares a passage from the book they are reading. Help them understand and enjoy it.
Keep answers clear and easy to read aloud: plain sentences, no markdown tables, minimal formatting.
Base your answer on the passage provided; if the question goes beyond it, say what you know about the book in general and say so.
Do not spoil later parts of the book unless the reader explicitly asks.`;

const ACTIONS = {
  summarize: () => "Summarize this passage in a short paragraph, then list the 3 most important points.",
  explain: () =>
    "Explain this passage in simple, everyday language, as if to a curious 12-year-old. Explain any old-fashioned or difficult words.",
  characters: () => "Who are the people or characters in this passage, and what is each of them doing or feeling?",
  vocab: () => "Pick up to 8 difficult or unusual words from this passage and give a short, simple definition for each.",
  ask: (q) => q,
};

async function handleAi(req, res) {
  if (!anthropic) {
    return sendJson(res, 503, {
      error: "The AI assistant is not set up. Start the server with ANTHROPIC_API_KEY set to enable it.",
    });
  }
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: "Invalid JSON" });
  }
  const action = ACTIONS[body.action] ? body.action : "ask";
  const question = String(body.question || "").slice(0, 2000).trim();
  if (action === "ask" && !question) return sendJson(res, 400, { error: "Please type a question." });
  const passage = String(body.text || "").slice(0, 60_000);
  const title = String(body.title || "Unknown book").slice(0, 300);
  const author = String(body.author || "").slice(0, 300);

  const history = Array.isArray(body.history) ? body.history.slice(-10) : [];
  const messages = [];
  for (const turn of history) {
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

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  const controller = new AbortController();
  res.on("close", () => controller.abort());

  try {
    const stream = anthropic.beta.messages.stream(
      {
        model: MODEL,
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default", // if the main model declines, the API retries on a fallback model
        output_config: { effort: "medium" },
        system: SYSTEM_PROMPT,
        messages,
      },
      { signal: controller.signal },
    );
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        send({ text: event.delta.text });
      }
    }
    const final = await stream.finalMessage();
    if (final.stop_reason === "refusal") {
      send({ error: "The assistant could not help with this request." });
    }
    send({ done: true });
  } catch (err) {
    if (!controller.signal.aborted) {
      let message = "The AI assistant ran into a problem. Please try again.";
      if (err instanceof Anthropic.AuthenticationError) message = "The AI API key is invalid.";
      else if (err instanceof Anthropic.RateLimitError) message = "The AI assistant is busy. Wait a moment and try again.";
      else if (err instanceof Anthropic.APIError) message = `AI error: ${err.message}`;
      console.error("AI error:", err);
      send({ error: message });
    }
  } finally {
    res.end();
  }
}

async function serveStatic(url, res) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/") rel = "/index.html";
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: "Forbidden" });
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  } catch {
    // Single-page app: unknown paths fall back to the app shell.
    const data = await fs.readFile(path.join(PUBLIC_DIR, "index.html"));
    res.writeHead(200, { "Content-Type": MIME[".html"] });
    res.end(data);
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname === "/api/status") return sendJson(res, 200, { ai: Boolean(anthropic), model: MODEL });
    if (url.pathname === "/api/search" && req.method === "GET") return await handleSearch(url, res);
    const m = url.pathname.match(/^\/api\/book\/([^/]+)$/);
    if (m && req.method === "GET") return await handleBook(m[1], res);
    if (url.pathname === "/api/ai" && req.method === "POST") return await handleAi(req, res);
    if (url.pathname.startsWith("/api/")) return sendJson(res, 404, { error: "Not found" });
    return await serveStatic(url, res);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendJson(res, err.status || 500, { error: err.message || "Server error" });
    else res.end();
  }
});

server.listen(PORT, () => {
  console.log(`📚 Ghanim Book Reader running at http://localhost:${PORT}`);
  console.log(anthropic ? `🤖 AI assistant enabled (${MODEL})` : "🤖 AI assistant disabled - set ANTHROPIC_API_KEY to enable it");
});
