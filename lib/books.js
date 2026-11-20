// Free public-domain ebooks from Project Gutenberg, via the Gutendex catalog API.
const GUTENDEX = process.env.GUTENDEX_URL || "https://gutendex.com/books";

// Small in-memory caches (per server instance) so repeated opens are instant.
const bookCache = new Map();
const jsonCache = new Map();

function remember(map, key, value, max) {
  map.set(key, value);
  if (map.size > max) map.delete(map.keys().next().value);
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
  if (jsonCache.has(url)) return jsonCache.get(url);
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) throw Object.assign(new Error(`Book catalog returned ${r.status}`), { status: 502 });
  const data = await r.json();
  remember(jsonCache, url, data, 200);
  return data;
}

export async function searchBooks({ q = "", page = 1, lang = "", topic = "" }) {
  const api = new URL(GUTENDEX);
  if (q) api.searchParams.set("search", q);
  if (lang) api.searchParams.set("languages", lang);
  if (topic) api.searchParams.set("topic", topic);
  if (page > 1) api.searchParams.set("page", String(page));
  api.searchParams.set("mime_type", "text/");
  const data = await fetchJson(api.toString());
  return {
    count: data.count,
    page,
    hasNext: Boolean(data.next),
    results: (data.results || []).map(simplifyBook),
  };
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

export function cleanGutenbergText(raw) {
  let text = raw.replace(/\r\n?/g, "\n");
  const start = text.search(/\*\*\*\s*START OF (THE|THIS) PROJECT GUTENBERG[^\n]*\n/i);
  if (start !== -1) text = text.slice(text.indexOf("\n", start) + 1);
  const end = text.search(/\*\*\*\s*END OF (THE|THIS) PROJECT GUTENBERG/i);
  if (end !== -1) text = text.slice(0, end);
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

export async function getBook(id) {
  if (!/^\d+$/.test(String(id))) throw Object.assign(new Error("Invalid book id"), { status: 400 });
  if (bookCache.has(id)) return bookCache.get(id);

  const meta = await fetchJson(`${GUTENDEX}/${id}`);
  const { url, html } = pickTextUrl(meta.formats, id);
  if (!new URL(url).hostname.endsWith("gutenberg.org")) {
    throw Object.assign(new Error("Unsupported book source"), { status: 400 });
  }
  const r = await fetch(url);
  if (!r.ok) throw Object.assign(new Error(`Could not download the book (${r.status})`), { status: 502 });
  let raw = await r.text();
  if (html) raw = stripHtml(raw);

  const book = { meta: simplifyBook(meta), text: cleanGutenbergText(raw) };
  remember(bookCache, id, book, 20);
  return book;
}
