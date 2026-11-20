// Free public-domain ebooks from two big libraries:
//  - Project Gutenberg (catalog via the Gutendex API, text from gutenberg.org or its official mirror)
//  - Open Library (catalog), with full texts from the Internet Archive
// Every request has a timeout and a fallback, so one library being slow or down
// doesn't break search or reading.
const GUTENDEX = process.env.GUTENDEX_URL || "https://gutendex.com/books";
const OPEN_LIBRARY = process.env.OPEN_LIBRARY_URL || "https://openlibrary.org";
const ARCHIVE = "https://archive.org";
const GUTENBERG_HOSTS = ["https://www.gutenberg.org", "https://gutenberg.pglaf.org"];
const HEADERS = { "User-Agent": "BookReader/1.0 (public-domain ebook reader)" };

// Small in-memory caches (per server instance) so repeated opens are instant.
const bookCache = new Map();
const jsonCache = new Map();

function remember(map, key, value, max) {
  map.set(key, value);
  if (map.size > max) map.delete(map.keys().next().value);
}

// Remembers services that just failed, so we skip them for a few minutes instead of
// making every visitor wait for the same timeout.
const downUntil = new Map();
const DOWN_FOR_MS = 5 * 60 * 1000;
const isDown = (name) => (downUntil.get(name) || 0) > Date.now();
const markDown = (name) => downUntil.set(name, Date.now() + DOWN_FOR_MS);
const markUp = (name) => downUntil.delete(name);

function httpError(message, status = 502) {
  return Object.assign(new Error(message), { status });
}

async function fetchWithTimeout(url, { timeout = 8000, retries = 0, accept } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await fetch(url, {
        headers: accept ? { ...HEADERS, Accept: accept } : HEADERS,
        signal: AbortSignal.timeout(timeout),
        redirect: "follow",
      });
      // Retry on "busy" answers; return everything else to the caller.
      if ((r.status === 429 || r.status >= 500) && attempt < retries) {
        lastErr = httpError(`${new URL(url).hostname} answered ${r.status}`);
        continue;
      }
      return r;
    } catch (err) {
      lastErr = err.name === "TimeoutError" ? httpError(`${new URL(url).hostname} took too long to answer`, 504) : err;
    }
  }
  throw lastErr;
}

async function fetchJson(url, opts = {}) {
  if (jsonCache.has(url)) return jsonCache.get(url);
  const r = await fetchWithTimeout(url, { accept: "application/json", ...opts });
  if (!r.ok) throw httpError(`${new URL(url).hostname} answered ${r.status}`);
  const data = await r.json();
  remember(jsonCache, url, data, 300);
  return data;
}

async function fetchText(url, opts = {}) {
  const r = await fetchWithTimeout(url, opts);
  if (!r.ok) throw httpError(`${new URL(url).hostname} answered ${r.status}`);
  const text = await r.text();
  // A maintenance page or error page is HTML, not a book.
  if (/^\s*<(!doctype|html)/i.test(text.slice(0, 200)) || text.length < 300) {
    throw httpError(`${new URL(url).hostname} didn't send the book text`);
  }
  return text;
}

// ---------------------------------------------------------------- Project Gutenberg

function fromGutendex(b) {
  const f = b.formats || {};
  return {
    source: "gutenberg",
    id: String(b.id),
    title: b.title,
    authors: (b.authors || []).map((a) => a.name),
    languages: b.languages || [],
    cover: f["image/jpeg"] || null,
  };
}

async function searchGutenberg({ q, page, lang, topic }) {
  const api = new URL(GUTENDEX);
  if (q) api.searchParams.set("search", q);
  if (lang) api.searchParams.set("languages", lang);
  if (topic) api.searchParams.set("topic", topic);
  if (page > 1) api.searchParams.set("page", String(page));
  api.searchParams.set("mime_type", "text/");
  if (isDown("gutendex")) throw httpError("Gutendex is down");
  try {
    const data = await fetchJson(api.toString(), { timeout: 8000 });
    markUp("gutendex");
    return { count: data.count, hasNext: Boolean(data.next), results: (data.results || []).map(fromGutendex) };
  } catch (err) {
    markDown("gutendex");
    throw err;
  }
}

// Official mirror layout: 14838 -> 1/4/8/3/14838/
function mirrorDir(id) {
  const s = String(id);
  return s.length === 1 ? `0/${s}` : `${s.slice(0, -1).split("").join("/")}/${s}`;
}

async function gutenbergText(id) {
  const urls = [
    ...GUTENBERG_HOSTS.filter((h) => !isDown(h)).map((h) => `${h}/cache/epub/${id}/pg${id}.txt`),
    `${GUTENBERG_HOSTS[1]}/${mirrorDir(id)}/${id}-0.txt`,
    `${GUTENBERG_HOSTS[1]}/${mirrorDir(id)}/${id}.txt`,
  ];
  let lastErr;
  for (const url of urls) {
    const host = new URL(url).origin;
    try {
      const text = await fetchText(url, { timeout: 12000 });
      markUp(host);
      return text;
    } catch (err) {
      lastErr = err;
      if (err.status !== 404) markDown(host);
    }
  }
  throw httpError(`Couldn't download this book from Project Gutenberg (${lastErr?.message || "no answer"}). Please try again later.`);
}

// Gutenberg files start with "Title: …", "Author: …" lines, so metadata still works if Gutendex is down.
function headerField(raw, name) {
  const m = raw.slice(0, 6000).match(new RegExp(`^${name}:\\s*(.+)$`, "im"));
  return m ? m[1].trim() : "";
}

export function cleanGutenbergText(raw) {
  let text = raw.replace(/\r\n?/g, "\n");
  const start = text.search(/\*\*\*\s*START OF (THE|THIS) PROJECT GUTENBERG[^\n]*\n/i);
  if (start !== -1) text = text.slice(text.indexOf("\n", start) + 1);
  const end = text.search(/\*\*\*\s*END OF (THE|THIS) PROJECT GUTENBERG/i);
  if (end !== -1) text = text.slice(0, end);
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

async function getGutenbergBook(id) {
  const [meta, raw] = await Promise.allSettled([
    isDown("gutendex") ? Promise.reject(new Error("down")) : fetchJson(`${GUTENDEX}/${id}`, { timeout: 6000 }),
    gutenbergText(id),
  ]);
  if (raw.status === "rejected") throw raw.reason;
  const text = raw.value;
  const info = meta.status === "fulfilled"
    ? fromGutendex(meta.value)
    : {
        source: "gutenberg",
        id: String(id),
        title: headerField(text, "Title") || `Book ${id}`,
        authors: headerField(text, "Author") ? [headerField(text, "Author")] : [],
        languages: [],
        cover: null,
      };
  return { meta: info, text: cleanGutenbergText(text) };
}

// ---------------------------------------------------------------- Open Library + Internet Archive

const OL_LANG = { en: "eng", fr: "fre", de: "ger", es: "spa", it: "ita", pt: "por", nl: "dut" };
const OL_FIELDS = "key,title,author_name,cover_i,id_project_gutenberg,language,first_publish_year,ia";

function fromOpenLibrary(doc) {
  const pg = (doc.id_project_gutenberg || []).find((x) => /^\d+$/.test(x));
  return {
    // Books Open Library knows are on Project Gutenberg open from there (cleaner text).
    source: pg ? "gutenberg" : "openlibrary",
    id: pg || doc.key.replace("/works/", ""),
    title: doc.title,
    authors: doc.author_name || [],
    languages: doc.language || [],
    year: doc.first_publish_year || null,
    cover: doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg` : null,
  };
}

async function searchOpenLibrary({ q, page, lang, topic }) {
  const parts = [];
  if (q) parts.push(q);
  if (topic) parts.push(`subject:"${topic.replace(/"/g, "")}"`);
  if (!q && !topic) parts.push('subject:"fiction"');
  parts.push("ebook_access:public"); // only books that are free to read in full
  if (OL_LANG[lang]) parts.push(`language:${OL_LANG[lang]}`);
  const api = new URL("/search.json", OPEN_LIBRARY);
  api.searchParams.set("q", parts.join(" "));
  api.searchParams.set("fields", OL_FIELDS);
  api.searchParams.set("limit", "24");
  api.searchParams.set("page", String(page));
  if (!q) api.searchParams.set("sort", "readinglog"); // most-read first
  const data = await fetchJson(api.toString(), { timeout: 9000, retries: 2 });
  const results = (data.docs || []).map(fromOpenLibrary);
  return { count: data.numFound || 0, hasNext: page * 24 < (data.numFound || 0), results };
}

// Finds a scan of this work on the Internet Archive that anyone may read (not lending-only).
async function publicArchiveScan(identifiers, preferLang) {
  const ids = identifiers.filter((x) => /^[\w.-]+$/.test(x)).slice(0, 40);
  if (!ids.length) return null;
  const api = new URL("/advancedsearch.php", ARCHIVE);
  api.searchParams.set("q", `identifier:(${ids.join(" OR ")}) AND mediatype:texts AND NOT access-restricted-item:true`);
  api.searchParams.append("fl[]", "identifier");
  api.searchParams.append("fl[]", "language");
  api.searchParams.append("sort[]", "downloads desc");
  api.searchParams.set("rows", "10");
  api.searchParams.set("output", "json");
  const data = await fetchJson(api.toString(), { timeout: 9000, retries: 1 });
  const docs = data.response?.docs || [];
  const lang = [].concat(preferLang || []);
  const match = docs.find((d) => [].concat(d.language || []).some((l) => lang.includes(String(l).toLowerCase())));
  return (match || docs[0])?.identifier || null;
}

async function archiveText(identifier) {
  try {
    return await archiveTextOnce(identifier);
  } catch (err) {
    if (err.status === 404) throw err;
    throw httpError("Couldn't download this book from the Internet Archive. Please try again in a moment.");
  }
}

async function archiveTextOnce(identifier) {
  try {
    return await fetchText(`${ARCHIVE}/download/${identifier}/${identifier}_djvu.txt`, { timeout: 15000, retries: 1 });
  } catch {
    // Some scans name their text file differently; look it up.
    const meta = await fetchJson(`${ARCHIVE}/metadata/${identifier}`, { timeout: 9000 });
    const file = (meta.files || []).find((f) => /\.txt$/i.test(f.name) && !/meta|license/i.test(f.name));
    if (!file) throw httpError("This book has no readable text yet.", 404);
    return fetchText(`${ARCHIVE}/download/${identifier}/${encodeURIComponent(file.name)}`, { timeout: 15000 });
  }
}

// Scanned books come from OCR: join hyphenated words and drop page numbers and running heads.
export function cleanScanText(raw) {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/\f/g, "\n")
    .replace(/(\w)-\n\s*(\w)/g, "$1$2")
    .split("\n")
    .filter((line) => !/^\s*(\d{1,4}|[ivxlc]{1,6}\.?)\s*$/i.test(line))
    .join("\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function getOpenLibraryBook(workId) {
  if (!/^OL\d+W$/.test(workId)) throw httpError("Invalid book id", 400);
  const api = new URL("/search.json", OPEN_LIBRARY);
  api.searchParams.set("q", `key:/works/${workId}`);
  api.searchParams.set("fields", OL_FIELDS);
  const data = await fetchJson(api.toString(), { timeout: 9000, retries: 2 });
  const doc = data.docs?.[0];
  if (!doc) throw httpError("Book not found on Open Library", 404);
  const info = fromOpenLibrary(doc);

  // Prefer Project Gutenberg's clean text when it has the book.
  if (info.source === "gutenberg") {
    try {
      const book = await getGutenbergBook(info.id);
      return { meta: { ...book.meta, cover: book.meta.cover || info.cover }, text: book.text };
    } catch {
      // fall through to the scanned copy
    }
  }
  const identifier = await publicArchiveScan(doc.ia || [], doc.language);
  if (!identifier) {
    throw httpError("This book can only be borrowed on Open Library, so it can't be read here. Try another edition.", 404);
  }
  const text = cleanScanText(await archiveText(identifier));
  return { meta: { ...info, source: "openlibrary", id: workId, archiveId: identifier }, text };
}

// ---------------------------------------------------------------- public API

const normalize = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// Searches both libraries at once; if one is down, results still come from the other.
export async function searchBooks({ q = "", page = 1, lang = "", topic = "", source = "all" }) {
  const wantGutenberg = source !== "openlibrary";
  const wantOpenLibrary = source !== "gutenberg";
  const [pg, ol] = await Promise.allSettled([
    wantGutenberg ? searchGutenberg({ q, page, lang, topic }) : null,
    wantOpenLibrary ? searchOpenLibrary({ q, page, lang, topic }) : null,
  ]);

  for (const p of [pg, ol]) if (p.status === "rejected") console.warn("Library search failed:", p.reason?.message);
  const warnings = [];
  if (wantGutenberg && pg.status === "rejected") warnings.push("Project Gutenberg isn't answering right now, so some books may be missing.");
  if (wantOpenLibrary && ol.status === "rejected") warnings.push("Open Library isn't answering right now, so some books may be missing.");
  const parts = [pg, ol].filter((p) => p.status === "fulfilled" && p.value).map((p) => p.value);
  if (!parts.length) throw httpError("Both book libraries are unreachable right now. Please try again in a few minutes.", 503);

  // Merge, skipping duplicates (same Gutenberg book, or same title and author).
  const seen = new Set();
  const results = [];
  for (const book of parts.flatMap((p) => p.results)) {
    const ids = [`${book.source}:${book.id}`, `t:${normalize(book.title)}|${normalize(book.authors[0])}`];
    if (ids.some((k) => seen.has(k))) continue;
    ids.forEach((k) => seen.add(k));
    results.push(book);
  }
  return {
    count: parts.reduce((n, p) => n + (p.count || 0), 0),
    page,
    hasNext: parts.some((p) => p.hasNext),
    results,
    warnings,
  };
}

export async function getBook(source, id) {
  const key = `${source}:${id}`;
  if (bookCache.has(key)) return bookCache.get(key);
  let book;
  if (source === "gutenberg") {
    if (!/^\d+$/.test(String(id))) throw httpError("Invalid book id", 400);
    book = await getGutenbergBook(String(id));
  } else if (source === "openlibrary") {
    book = await getOpenLibraryBook(String(id));
  } else {
    throw httpError("Unknown library", 400);
  }
  remember(bookCache, key, book, 20);
  return book;
}
