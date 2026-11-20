// Ghanim Book Reader - front end
const $ = (sel) => document.querySelector(sel);

const PAGE_CHARS = 3500; // roughly one screen of reading per "page"
const BEDTIME_RATE = 0.85; // a calmer, slower voice for bedtime

// Hand-picked classics from Project Gutenberg that work well at bedtime.
const BEDTIME_BOOKS = [
  { id: 14838, olCover: 289591, title: "The Tale of Peter Rabbit", author: "Beatrix Potter" },
  { id: 11757, olCover: 1340606, title: "The Velveteen Rabbit", author: "Margery Williams" },
  { id: 2781, olCover: 36215, title: "Just So Stories", author: "Rudyard Kipling" },
  { id: 2591, olCover: 7895815, title: "Grimms' Fairy Tales", author: "Jacob and Wilhelm Grimm" },
  { id: 1597, olCover: 320591, title: "Andersen's Fairy Tales", author: "Hans Christian Andersen" },
  { id: 21, olCover: 5796201, title: "Aesop's Fables", author: "Aesop" },
  { id: 11, olCover: 10527843, title: "Alice's Adventures in Wonderland", author: "Lewis Carroll" },
  { id: 16, olCover: 8237052, title: "Peter Pan", author: "J. M. Barrie" },
  { id: 55, olCover: 552443, title: "The Wonderful Wizard of Oz", author: "L. Frank Baum" },
  { id: 236, olCover: null, title: "The Jungle Book", author: "Rudyard Kipling" },
  { id: 500, olCover: 11365679, title: "The Adventures of Pinocchio", author: "Carlo Collodi" },
  { id: 113, olCover: 12622062, title: "The Secret Garden", author: "Frances Hodgson Burnett" },
].map((b) => ({ ...b, source: "gutenberg", cover: b.olCover ? `https://covers.openlibrary.org/b/id/${b.olCover}-M.jpg` : null }));

const isRemoteKey = (key) => key.startsWith("g") || key.startsWith("o");
const remoteKey = (id) => (/^OL\d+W$/.test(id) ? "o" : "g") + id;
const LANG2 = { eng: "en", fre: "fr", fra: "fr", ger: "de", deu: "de", spa: "es", ita: "it", por: "pt", dut: "nl", nld: "nl" };
const SOURCE_LABEL = { gutenberg: "Project Gutenberg", openlibrary: "Open Library" };

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  },
  remove(key) {
    try { localStorage.removeItem(key); } catch {}
  },
};

const settings = Object.assign(
  { fontSize: 19, font: "serif", theme: "", rate: 1, voice: "", bedtime: false, dayTheme: "", sound: "", soundVolume: 0.35 },
  store.get("settings", {}),
);

const state = {
  book: null, // { key, id, title, author, cover, lang, text }
  paragraphs: [],
  pages: [], // [startIndex, endIndex)
  headings: [], // paragraph indexes of chapter / story titles
  page: 0,
  search: { q: "", lang: "", topic: "", page: 1 },
  aiHistory: [],
  aiAvailable: true,
};

// ---------------------------------------------------------------- helpers
function showLoading(text = "Loading…") {
  $("#loading-text").textContent = text;
  $("#loading").hidden = false;
}
function hideLoading() {
  $("#loading").hidden = true;
}
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) node.setAttribute(k, v);
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}
async function api(path) {
  const r = await fetch(path);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
  return data;
}

// Reads a server-sent event stream from our API, calling onText for each chunk of text.
async function streamApi(path, payload, onText, signal) {
  const r = await fetch(path, {
    signal,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok || !r.body) {
    const data = await r.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (${r.status})`);
  }
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let full = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const line = buf.slice(0, idx).replace(/^data: /, "");
      buf = buf.slice(idx + 2);
      if (!line) continue;
      const evt = JSON.parse(line);
      if (evt.error) throw Object.assign(new Error(evt.error), { partial: full });
      if (evt.text) {
        full += evt.text;
        onText(full);
      }
    }
  }
  if (!full) throw new Error("Nothing came back. Please try again.");
  return full;
}

// ---------------------------------------------------------------- settings
function applySettings() {
  const root = document.documentElement;
  if (settings.theme) root.dataset.theme = settings.theme;
  else delete root.dataset.theme;
  root.style.setProperty("--reader-size", settings.fontSize + "px");
  const fonts = {
    serif: 'Georgia, "Iowan Old Style", "Palatino Linotype", serif',
    sans: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    dyslexic: 'Verdana, Tahoma, "Trebuchet MS", sans-serif',
  };
  root.style.setProperty("--reader-font", fonts[settings.font] || fonts.serif);
  $("#page").style.letterSpacing = settings.font === "dyslexic" ? "0.04em" : "";
  $("#page").style.wordSpacing = settings.font === "dyslexic" ? "0.12em" : "";
  $("#font-size").value = settings.fontSize;
  $("#font-family").value = settings.font;
  $("#tts-rate").value = settings.rate;
  $("#tts-rate-val").textContent = Number(settings.rate).toFixed(2).replace(/0$/, "") + "×";
  $("#sound-volume").value = settings.soundVolume;
  $("#sound-select").value = sound.kind;
  document.querySelectorAll(".theme-row button").forEach((b) =>
    b.setAttribute("aria-pressed", String(b.dataset.theme === settings.theme)),
  );
  $("#bedtime-toggle").setAttribute("aria-pressed", String(settings.bedtime));
  $("#bedtime-toggle").textContent = settings.bedtime ? "☀️ Daytime mode" : "🌙 Bedtime mode";
  $("#hero-title").textContent = settings.bedtime
    ? "Time for a bedtime story."
    : "Find a book. Read it. Or let it read to you.";
  $("#hero-sub").textContent = settings.bedtime
    ? "Pick a classic, or make up a new one. It reads aloud softly, then fades out when it's time to sleep."
    : "Search hundreds of thousands of free books from Project Gutenberg and Open Library.";
  document.querySelector('meta[name="theme-color"]').content = getComputedStyle(root).getPropertyValue("--surface").trim() || "#ffffff";
  store.set("settings", settings);
}

function setBedtimeMode(on) {
  if (on === settings.bedtime) return;
  settings.bedtime = on;
  if (on) {
    settings.dayTheme = settings.theme;
    settings.theme = "night";
    settings.rate = Math.min(settings.rate, BEDTIME_RATE);
  } else {
    settings.theme = settings.dayTheme === "night" ? "" : settings.dayTheme;
    settings.rate = 1;
  }
  applySettings();
  // Bedtime stories go first at night.
  const bedtime = $("#bedtime-section");
  const shelf = $("#shelf-section");
  if (on) shelf.before(bedtime);
  else shelf.after(bedtime);
}

// ---------------------------------------------------------------- library
function coverEl(book) {
  const placeholder = el("div", { class: "cover placeholder" }, book.title);
  if (!book.cover) return placeholder;
  const img = el("img", { class: "cover", src: book.cover, alt: "", loading: "lazy" });
  img.addEventListener("error", () => img.replaceWith(placeholder), { once: true });
  return img;
}

function bookCard(book, onClick, progress) {
  return el(
    "button",
    { class: "card", onclick: onClick, title: book.title },
    coverEl(book),
    el(
      "div",
      { class: "info" },
      el("div", { class: "title" }, book.title),
      el("div", { class: "author" }, (book.authors || [book.author]).filter(Boolean).join(", ") || "Unknown author"),
      book.source && progress == null
        ? el("div", { class: `source ${book.source}` }, SOURCE_LABEL[book.source] + (book.year ? ` · ${book.year}` : ""))
        : null,
      progress != null
        ? el("div", { class: "progress-bar" }, el("span", { style: `width:${Math.round(progress * 100)}%` }))
        : null,
    ),
  );
}

function renderBedtimeShelf() {
  const makeCard = el(
    "button",
    { class: "card make-story", onclick: openStoryMaker, title: "Make up a new bedtime story" },
    el("div", { class: "cover" }, el("span", {}, "✨"), "Make up a new story"),
    el("div", { class: "info" }, el("div", { class: "title" }, "A story just for tonight"), el("div", { class: "author" }, "Written by AI")),
  );
  $("#bedtime-shelf").replaceChildren(
    makeCard,
    ...BEDTIME_BOOKS.map((b) => bookCard({ ...b, source: null }, () => (location.hash = `#/book/${b.id}`))),
  );
}

function renderShelf() {
  const shelf = store.get("shelf", []);
  const box = $("#shelf");
  box.replaceChildren();
  $("#shelf-section").hidden = shelf.length === 0;
  for (const item of shelf) {
    const progress = item.pages ? (item.page + 1) / item.pages : 0;
    box.append(bookCard(item, () => openFromShelf(item), progress));
  }
}

async function runSearch() {
  const { q, lang, topic, page } = state.search;
  const params = new URLSearchParams();
  const source = $("#source-select").value;
  if (source) params.set("source", source);
  if (q) params.set("q", q);
  if (lang) params.set("lang", lang);
  if (topic) params.set("topic", topic);
  if (page > 1) params.set("page", page);

  const title = q ? `Results for “${q}”` : topic ? `Popular in ${topic}` : "Popular books";
  $("#results-title").textContent = title;
  $("#results-status").textContent = "Searching…";
  $("#results").replaceChildren();
  $("#prev-page").hidden = $("#next-page").hidden = true;

  try {
    const data = await api("/api/search?" + params);
    $("#results").replaceChildren(
      ...data.results.map((b) => bookCard(b, () => (location.hash = `#/book/${b.id}`))),
    );
    const summary = data.results.length
      ? `${data.count.toLocaleString()} books found · page ${page}`
      : "No books found. Try another search, or another library.";
    $("#results-status").textContent = [summary, ...(data.warnings || [])].join("  ·  ");
    $("#prev-page").hidden = page <= 1;
    $("#next-page").hidden = !data.hasNext;
  } catch (err) {
    $("#results-status").replaceChildren(
      "Couldn't search right now: " + err.message + " ",
      el("button", { class: "btn ghost small", onclick: runSearch }, "Try again"),
    );
  }
}

// ---------------------------------------------------------------- book parsing
function splitParagraphs(text) {
  const blocks = text.split(/\n\s*\n/);
  const out = [];
  for (const block of blocks) {
    // Gutenberg texts hard-wrap lines at ~70 chars; re-join them, but keep poetry-like short lines.
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    const avg = lines.reduce((s, l) => s + l.length, 0) / lines.length;
    const joined = lines.length > 1 && avg > 45 ? lines.join(" ") : lines.join("\n");
    out.push(joined);
  }
  return out;
}

function isHeading(p) {
  if (p.length > 80 || p.includes("\n")) return false;
  return /^(chapter|book|part|act|scene|volume|letter|canto|stave|fable|story|tale)\b/i.test(p) ||
    (p === p.toUpperCase() && /[A-Z]/.test(p) && p.length < 60);
}

function paginate(paragraphs) {
  const pages = [];
  let start = 0;
  let chars = 0;
  paragraphs.forEach((p, i) => {
    // Start chapters / stories on a fresh page when the current page already has content.
    if (i > start && (chars + p.length > PAGE_CHARS || (isHeading(p) && chars > PAGE_CHARS * 0.25))) {
      pages.push([start, i]);
      start = i;
      chars = 0;
    }
    chars += p.length;
  });
  if (start < paragraphs.length) pages.push([start, paragraphs.length]);
  return pages.length ? pages : [[0, 0]];
}

const pageOf = (i) => state.pages.findIndex(([s, e]) => i >= s && i < e);

function buildToc() {
  // Skip the title-page headings that come before the first real chapter/story text.
  state.headings = state.paragraphs.map((p, i) => (isHeading(p) ? i : -1)).filter((i) => i >= 0);
  const toc = $("#toc");
  toc.replaceChildren(el("option", { value: "" }, "📖 Jump to a story or chapter…"));
  for (const i of state.headings) {
    const label = state.paragraphs[i].replace(/\s+/g, " ").slice(0, 70);
    toc.append(el("option", { value: i }, label));
  }
  $("#toc-bar").hidden = state.headings.length < 3;
}

// ---------------------------------------------------------------- opening books
function loadBook(book, startPage = 0) {
  stopSpeaking();
  state.book = book;
  state.paragraphs = splitParagraphs(book.text);
  state.pages = paginate(state.paragraphs);
  state.page = Math.min(startPage, state.pages.length - 1);
  state.aiHistory = [];
  $("#ai-log").replaceChildren();
  $("#book-title").textContent = book.title;
  $("#book-author").textContent = book.author || "";
  document.title = `${book.title} · Ghanim Book Reader`;
  $("#progress").max = state.pages.length - 1;
  buildToc();
  pickDefaultVoice();
  showView("reader");
  renderPage();
  saveProgress();
}

async function openRemoteBook(id) {
  const key = remoteKey(id);
  const saved = store.get("shelf", []).find((s) => s.key === key);
  showLoading(key.startsWith("o") ? "Opening the book from the Internet Archive…" : "Opening the book…");
  try {
    const { meta, text } = await api(`/api/book/${id}`);
    loadBook(
      {
        key,
        id,
        title: meta.title,
        author: meta.authors.join(", "),
        cover: meta.cover,
        lang: LANG2[meta.languages[0]] || (meta.languages[0] || "en").slice(0, 2),
        scanned: meta.source === "openlibrary",
        text,
      },
      saved ? saved.page : 0,
    );
  } catch (err) {
    alert("Sorry, this book couldn't be opened: " + err.message);
    location.hash = "";
  } finally {
    hideLoading();
  }
}

function openFromShelf(item) {
  if (isRemoteKey(item.key)) {
    location.hash = `#/book/${item.id}`;
  } else {
    const text = store.get("file:" + item.key, null);
    if (!text) {
      alert("This story isn't saved in your browser anymore.");
      return;
    }
    location.hash = `#/file/${item.key}`;
  }
}

function openLocalFile(key) {
  const item = store.get("shelf", []).find((s) => s.key === key);
  const text = store.get("file:" + key, null);
  if (!item || !text) {
    location.hash = "";
    return;
  }
  loadBook({ ...item, text }, item.page || 0);
}

// Saves a local text (an uploaded file or a made-up story) and opens it.
function openLocalText({ prefix, title, author, text }) {
  const key = prefix + Date.now().toString(36);
  const book = { key, title, author, cover: null, lang: navigator.language.slice(0, 2), text };
  if (!store.set("file:" + key, text)) {
    // Too big for browser storage - still readable, just not kept on the shelf.
    loadBook(book);
    return;
  }
  const shelf = store.get("shelf", []).filter((s) => s.key !== key);
  shelf.unshift({ key, title, author, cover: null, lang: book.lang, page: 0, pages: 1, updated: Date.now() });
  store.set("shelf", shelf);
  location.hash = `#/file/${key}`;
}

async function handleFile(file) {
  if (!file) return;
  const text = await file.text();
  const title = file.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ");
  openLocalText({ prefix: "f", title, author: "Your file", text });
}

function saveProgress() {
  const b = state.book;
  if (!b) return;
  let shelf = store.get("shelf", []).filter((s) => s.key !== b.key);
  shelf.unshift({
    key: b.key, id: b.id, title: b.title, author: b.author, cover: b.cover, lang: b.lang,
    page: state.page, pages: state.pages.length, updated: Date.now(),
  });
  // Keep the 12 most recent books; drop stored text for local books that fall off the shelf.
  for (const old of shelf.slice(12)) if (!isRemoteKey(old.key)) store.remove("file:" + old.key);
  shelf = shelf.slice(0, 12);
  store.set("shelf", shelf);
}

// ---------------------------------------------------------------- reader
function renderPage() {
  const [start, end] = state.pages[state.page];
  const page = $("#page");
  page.replaceChildren();
  for (let i = start; i < end; i++) {
    const p = state.paragraphs[i];
    const isTitle = isHeading(p) || (i === 0 && state.book.key.startsWith("s")); // made-up stories start with their title
    const node = el(isTitle ? "h3" : "p", { "data-i": i, class: "clickable", title: "Tap to read aloud from here" }, p);
    node.addEventListener("click", () => {
      if (window.getSelection().toString()) return; // don't hijack text selection
      speakFrom(i);
    });
    page.append(node);
  }
  if (state.page === 0 && state.book.scanned) {
    page.prepend(el("p", { class: "scan-note" }, "📜 Scanned from a printed book by the Internet Archive, so a few words may be misread."));
  }
  if (state.page === state.pages.length - 1) page.append(el("p", { class: "page-end" }, "🌙 The End"));
  page.scrollTop = 0;
  $("#page-info").textContent = `Page ${state.page + 1} of ${state.pages.length}`;
  $("#progress").value = state.page;
  $("#prev-btn").disabled = state.page === 0;
  $("#next-btn").disabled = state.page >= state.pages.length - 1;
  // Show which story / chapter we're in.
  const current = state.headings.filter((h) => h < end).pop();
  $("#toc").value = current != null ? String(current) : "";
}

function goToPage(n, { keepSpeaking = false } = {}) {
  const target = Math.max(0, Math.min(state.pages.length - 1, n));
  if (target === state.page) return;
  if (!keepSpeaking) stopSpeaking();
  state.page = target;
  renderPage();
  saveProgress();
}

function currentPageText() {
  const [start, end] = state.pages[state.page];
  return state.paragraphs.slice(start, end).join("\n\n");
}

// ---------------------------------------------------------------- soft sounds (generated, no downloads)
const sound = {
  ctx: null,
  master: null,
  nodes: [],
  kind: "",

  noiseBuffer(type) {
    const ctx = this.ctx;
    const len = ctx.sampleRate * 8;
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let last = 0;
      for (let i = 0; i < len; i++) {
        const white = Math.random() * 2 - 1;
        if (type === "brown") {
          last = (last + 0.02 * white) / 1.02;
          d[i] = last * 3.5;
        } else d[i] = white;
      }
      // Crossfade the ends so the loop is seamless.
      const fade = 2000;
      for (let i = 0; i < fade; i++) {
        const t = i / fade;
        d[len - fade + i] = d[len - fade + i] * (1 - t) + d[i] * t;
      }
    }
    return buf;
  },

  play(kind) {
    this.stop(0.4);
    this.kind = kind;
    if (!kind) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx ||= new AC();
    const ctx = this.ctx;
    ctx.resume();
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(ctx.destination);

    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer(kind === "rain" ? "white" : "brown");
    src.loop = true;
    let out = src;
    const nodes = [src];

    if (kind === "rain") {
      const hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 900;
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 6000;
      const g = ctx.createGain();
      g.gain.value = 0.25;
      src.connect(hp).connect(lp).connect(g);
      out = g;
      nodes.push(hp, lp, g);
    } else if (kind === "ocean") {
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 700;
      const swell = ctx.createGain();
      swell.gain.value = 0.55;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.09; // one slow wave about every 11 seconds
      const depth = ctx.createGain();
      depth.gain.value = 0.45;
      lfo.connect(depth).connect(swell.gain);
      lfo.start();
      src.connect(lp).connect(swell);
      out = swell;
      nodes.push(lp, swell, lfo, depth);
    }
    out.connect(this.master);
    src.start();
    this.nodes = nodes;
    this.setVolume(settings.soundVolume, 2);
  },

  setVolume(v, seconds = 0.3) {
    if (!this.master) return;
    const g = this.master.gain;
    const now = this.ctx.currentTime;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(v * 0.6, now + seconds);
  },

  stop(seconds = 0.4) {
    if (!this.master) return;
    const master = this.master;
    const nodes = this.nodes;
    this.master = null;
    this.nodes = [];
    this.kind = "";
    const now = this.ctx.currentTime;
    master.gain.cancelScheduledValues(now);
    master.gain.setValueAtTime(master.gain.value, now);
    master.gain.linearRampToValueAtTime(0, now + seconds);
    setTimeout(() => {
      nodes.forEach((n) => { try { n.stop?.(); n.disconnect(); } catch {} });
      master.disconnect();
    }, seconds * 1000 + 100);
  },
};

// ---------------------------------------------------------------- keep the screen awake while reading
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && !wakeLock && navigator.wakeLock) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => (wakeLock = null));
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {}
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && tts.playing) keepAwake(true);
});

// ---------------------------------------------------------------- sleep timer
const sleep = { mode: "0", endsAt: 0, tick: null, storyStart: -1, fadeSeconds: 60 };

function setSleepTimer(value) {
  clearInterval(sleep.tick);
  sleep.mode = value;
  sleep.endsAt = 0;
  sleep.storyStart = -1;
  $("#sleep-timer").value = value;
  if (value === "story") {
    sleep.storyStart = tts.playing ? tts.index : state.pages[state.page]?.[0] ?? 0;
  } else if (Number(value) > 0) {
    sleep.endsAt = Date.now() + Number(value) * 60_000;
    sleep.tick = setInterval(updateSleepTimer, 1000);
  }
  updateSleepTimer();
}

// 1 normally; goes down to 0 over the last minute of the timer.
function fadeLevel() {
  if (!sleep.endsAt) return 1;
  const left = (sleep.endsAt - Date.now()) / 1000;
  return Math.max(0, Math.min(1, left / sleep.fadeSeconds));
}

function updateSleepTimer() {
  const label = $("#timer-label");
  if (sleep.mode === "story") label.textContent = "Story end";
  else if (sleep.endsAt) {
    const left = Math.max(0, Math.round((sleep.endsAt - Date.now()) / 1000));
    label.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
    if (sound.master && left <= sleep.fadeSeconds) sound.setVolume(settings.soundVolume * fadeLevel(), 1);
    if (left <= 0) return sweetDreams();
  } else label.textContent = "Bedtime";
  label.classList.toggle("hide-sm", sleep.mode === "0"); // keep the countdown visible on phones
  $("#night-btn").setAttribute("aria-pressed", String(sleep.mode !== "0"));
}

function sweetDreams() {
  setSleepTimer("0");
  stopSpeaking();
  sound.stop(8);
  $("#sound-select").value = "";
  dimScreen(true, "Sweet dreams 🌙  ·  tap to wake");
}

function dimScreen(on, text = "Tap to wake the screen") {
  $("#dim-text").textContent = text;
  $("#dim-overlay").hidden = !on;
  closePopovers();
}

// ---------------------------------------------------------------- read aloud (text to speech)
const synth = window.speechSynthesis;
const tts = { playing: false, index: -1, run: 0, mode: "book", errors: 0 };

function voices() {
  return synth ? synth.getVoices() : [];
}

function populateVoices() {
  const select = $("#tts-voice");
  const list = voices();
  select.replaceChildren(
    ...list.map((v) => el("option", { value: v.voiceURI }, `${v.name} (${v.lang})`)),
  );
  if (!list.length) select.append(el("option", { value: "" }, "Default voice"));
  pickDefaultVoice();
}

function pickDefaultVoice() {
  const list = voices();
  if (!list.length) return;
  const lang = (state.book?.lang || navigator.language || "en").slice(0, 2);
  let voice = list.find((v) => v.voiceURI === settings.voice && v.lang.startsWith(lang));
  voice ||= list.find((v) => v.lang.startsWith(lang) && /natural|neural|premium|enhanced|google/i.test(v.name));
  voice ||= list.find((v) => v.lang.startsWith(lang) && v.default);
  voice ||= list.find((v) => v.lang.startsWith(lang));
  voice ||= list.find((v) => v.voiceURI === settings.voice) || list[0];
  $("#tts-voice").value = voice.voiceURI;
}

function selectedVoice() {
  return voices().find((v) => v.voiceURI === $("#tts-voice").value) || null;
}

// Browsers stop long utterances early, so speak in sentence-sized chunks.
function chunkText(text) {
  const sentences = text.replace(/\s+/g, " ").match(/[^.!?;:]+[.!?;:]+["'”’)]*\s*|[^.!?;:]+$/g) || [text];
  const chunks = [];
  let cur = "";
  for (const s of sentences) {
    if ((cur + s).length > 220 && cur) {
      chunks.push(cur.trim());
      cur = "";
    }
    if (s.length > 220) {
      for (const piece of s.match(/.{1,200}(\s|$)/g) || [s]) chunks.push(piece.trim());
    } else cur += s;
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks.filter(Boolean);
}

function speakChunks(chunks, run, onDone) {
  let i = 0;
  const next = () => {
    if (run !== tts.run) return;
    if (i >= chunks.length) return onDone();
    const u = new SpeechSynthesisUtterance(chunks[i++]);
    const v = selectedVoice();
    if (v) {
      u.voice = v;
      u.lang = v.lang;
    }
    u.rate = Number(settings.rate);
    // In bedtime mode the voice is a little softer, and it fades out as the sleep timer ends.
    u.volume = Math.max(0.15, (settings.bedtime ? 0.85 : 1) * fadeLevel());
    u.onstart = () => (tts.errors = 0);
    u.onend = next;
    u.onerror = (e) => {
      if (e.error === "interrupted" || e.error === "canceled") return;
      // Skip a sentence the voice can't say, but don't race through the book if speech is broken.
      if (++tts.errors >= 3) {
        stopSpeaking();
        alert("Reading aloud stopped because this voice isn't working. Try picking another voice.");
      } else next();
    };
    synth.speak(u);
  };
  next();
}

function highlight(index) {
  document.querySelectorAll("#page .speaking").forEach((n) => n.classList.remove("speaking"));
  const node = document.querySelector(`#page [data-i="${index}"]`);
  if (node) {
    node.classList.add("speaking");
    node.scrollIntoView({ block: "center", behavior: "smooth" });
  }
}

function speakFrom(index) {
  if (!synth) {
    alert("Your browser doesn't support reading aloud. Try Chrome, Edge or Safari.");
    return;
  }
  synth.cancel();
  if (index >= state.paragraphs.length) {
    stopSpeaking();
    if (sleep.mode !== "0") sweetDreams();
    return;
  }
  // "Stop at the end of this story": stop when the next story or chapter title comes up.
  if (sleep.mode === "story") {
    if (sleep.storyStart < 0 || !tts.playing) sleep.storyStart = index;
    else if (index > sleep.storyStart && isHeading(state.paragraphs[index])) return sweetDreams();
  }

  const run = ++tts.run;
  tts.playing = true;
  tts.mode = "book";
  tts.index = index;
  updateTtsButtons();
  keepAwake(true);

  // Turn the page automatically when the reader reaches the end of it.
  const p = pageOf(index);
  if (p !== -1 && p !== state.page) goToPage(p, { keepSpeaking: true });

  highlight(index);
  speakChunks(chunkText(state.paragraphs[index]), run, () => speakFrom(index + 1));
}

function speakText(text) {
  if (!synth) return;
  synth.cancel();
  const run = ++tts.run;
  tts.playing = true;
  tts.mode = "answer";
  updateTtsButtons();
  keepAwake(true);
  speakChunks(chunkText(text), run, stopSpeaking);
}

function stopSpeaking() {
  tts.run++;
  tts.playing = false;
  if (synth) synth.cancel();
  document.querySelectorAll("#page .speaking").forEach((n) => n.classList.remove("speaking"));
  updateTtsButtons();
  keepAwake(false);
}

function togglePlay() {
  if (tts.playing) {
    // "Pause": stop, but remember where we were so play resumes from that paragraph.
    const resumeAt = tts.mode === "book" ? tts.index : -1;
    stopSpeaking();
    tts.index = resumeAt;
    return;
  }
  const [start, end] = state.pages[state.page];
  const resume = tts.index >= start && tts.index < end ? tts.index : start;
  speakFrom(resume);
}

function updateTtsButtons() {
  $("#tts-play").textContent = tts.playing ? "❚❚ Pause" : "▶ Read to me";
  $("#tts-stop").disabled = !tts.playing;
}

// ---------------------------------------------------------------- AI assistant
function addMsg(role, text = "") {
  const body = el("div", { class: "body" }, text);
  const msg = el("div", { class: `msg ${role}` }, body);
  $("#ai-log").append(msg);
  $("#ai-log").scrollTop = $("#ai-log").scrollHeight;
  return { msg, body };
}

const QUICK_LABELS = {
  retell: "Retell this page for a little one",
  summarize: "Summarize this page",
  explain: "Explain this page simply",
  characters: "Who's who on this page?",
  vocab: "What are the hard words?",
};

const AI_OFF = "The AI assistant isn't set up yet. Add an ANTHROPIC_API_KEY environment variable on the server (or in your Vercel project settings) to turn it on.";

async function askAi(action, question = "") {
  if (!state.aiAvailable) {
    addMsg("error", AI_OFF);
    return;
  }
  const userText = action === "ask" ? question : QUICK_LABELS[action];
  addMsg("user", userText);
  const { msg, body } = addMsg("assistant", "Thinking…");
  const buttons = document.querySelectorAll("#ai-form button, .ai-quick button");
  buttons.forEach((b) => (b.disabled = true));

  try {
    const answer = await streamApi(
      "/api/ai",
      {
        action,
        question,
        text: currentPageText(),
        title: state.book.title,
        author: state.book.author,
        history: state.aiHistory,
      },
      (full) => {
        body.textContent = full;
        $("#ai-log").scrollTop = $("#ai-log").scrollHeight;
      },
    );
    state.aiHistory.push({ role: "user", content: userText }, { role: "assistant", content: answer });
    msg.append(el("button", { class: "speak", onclick: () => speakText(answer) }, "🔊 Read this aloud"));
  } catch (err) {
    msg.className = "msg error";
    body.textContent = err.partial ? err.partial + "\n\n⚠ " + err.message : err.message;
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}

// ---------------------------------------------------------------- AI story maker
let storyAbort = null;

function openStoryMaker() {
  $("#story-preview").hidden = true;
  $("#story-error").hidden = true;
  $("#story-go").disabled = false;
  $("#story-go").textContent = "Write my story";
  $("#story-name").value ||= store.get("childName", "");
  $("#story-dialog").showModal();
}

async function writeStory() {
  if (!state.aiAvailable) {
    $("#story-error").textContent = AI_OFF;
    $("#story-error").hidden = false;
    return;
  }
  const name = $("#story-name").value.trim();
  store.set("childName", name);
  const preview = $("#story-preview");
  preview.hidden = false;
  preview.textContent = "✨ Thinking up a story…";
  $("#story-error").hidden = true;
  $("#story-go").disabled = true;
  $("#story-go").textContent = "Writing…";
  storyAbort = new AbortController();

  try {
    const text = await streamApi(
      "/api/story",
      { name, about: $("#story-about").value.trim(), age: $("#story-age").value, length: $("#story-length").value },
      (full) => {
        preview.textContent = full;
        preview.scrollTop = preview.scrollHeight;
      },
      storyAbort.signal,
    );
    const m = text.match(/^\s*Title:\s*(.+)\n/i);
    const title = (m ? m[1] : "A Bedtime Story").replace(/[*_#"]/g, "").trim();
    const storyText = (m ? text.slice(m[0].length) : text).trim();
    $("#story-dialog").close();
    openLocalText({ prefix: "s", title, author: name ? `A story for ${name}` : "A bedtime story", text: `${title}\n\n${storyText}` });
    // Start reading straight away; if the browser blocks it, the Read button still works.
    setTimeout(() => speakFrom(0), 400);
  } catch (err) {
    if (err.name !== "AbortError") {
      $("#story-error").textContent = err.message;
      $("#story-error").hidden = false;
    }
  } finally {
    $("#story-go").disabled = false;
    $("#story-go").textContent = "Write my story";
    storyAbort = null;
  }
}

// ---------------------------------------------------------------- panels, views & routing
function closePopovers(except) {
  for (const [panel, btn] of [["#settings-panel", "#settings-btn"], ["#night-panel", "#night-btn"]]) {
    if (panel === except) continue;
    $(panel).hidden = true;
    $(btn).setAttribute("aria-expanded", "false");
  }
}

function togglePopover(panel, btn) {
  const p = $(panel);
  closePopovers(panel);
  p.hidden = !p.hidden;
  $(btn).setAttribute("aria-expanded", String(!p.hidden));
}

function toggleAiPanel(force) {
  const panel = $("#ai-panel");
  const open = force ?? panel.hidden;
  panel.hidden = !open;
  $("#ai-btn").setAttribute("aria-expanded", String(open));
  if (open) {
    closePopovers();
    $("#ai-input").focus();
  }
}

function showView(name) {
  $("#library-view").hidden = name !== "library";
  $("#reader-view").hidden = name !== "reader";
  closePopovers();
  if (name === "library") {
    stopSpeaking();
    document.title = "Ghanim Book Reader";
    renderShelf();
  }
}

function route() {
  const m = location.hash.match(/^#\/(book|file)\/([\w-]+)/);
  if (!m) return showView("library");
  if (state.book && state.book.key === (m[1] === "book" ? remoteKey(m[2]) : m[2])) return showView("reader");
  if (m[1] === "book") openRemoteBook(m[2]);
  else openLocalFile(m[2]);
}

// ---------------------------------------------------------------- wire up
function init() {
  applySettings();
  if (settings.bedtime) $("#shelf-section").before($("#bedtime-section"));
  renderBedtimeShelf();
  renderShelf();

  $("#bedtime-toggle").addEventListener("click", () => setBedtimeMode(!settings.bedtime));
  $("#search-form").addEventListener("submit", (e) => {
    e.preventDefault();
    state.search = { q: $("#search-input").value.trim(), lang: $("#lang-select").value, topic: "", page: 1 };
    document.querySelectorAll("#topic-chips button").forEach((b) => b.classList.remove("active"));
    runSearch();
  });
  $("#topic-chips").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    document.querySelectorAll("#topic-chips button").forEach((x) => x.classList.toggle("active", x === b));
    state.search = { q: "", lang: $("#lang-select").value, topic: b.dataset.topic, page: 1 };
    $("#search-input").value = "";
    runSearch();
  });
  $("#source-select").addEventListener("change", () => { state.search.page = 1; runSearch(); });
  $("#prev-page").addEventListener("click", () => { state.search.page--; runSearch(); });
  $("#next-page").addEventListener("click", () => { state.search.page++; runSearch(); });
  $("#file-input").addEventListener("change", (e) => { handleFile(e.target.files[0]); e.target.value = ""; });

  // Reader
  $("#back-btn").addEventListener("click", () => (location.hash = ""));
  $("#prev-btn").addEventListener("click", () => goToPage(state.page - 1));
  $("#next-btn").addEventListener("click", () => goToPage(state.page + 1));
  $("#progress").addEventListener("change", (e) => goToPage(Number(e.target.value)));
  $("#toc").addEventListener("change", (e) => {
    if (e.target.value === "") return;
    const i = Number(e.target.value);
    if (tts.playing) speakFrom(i);
    else goToPage(pageOf(i));
  });

  $("#settings-btn").addEventListener("click", () => togglePopover("#settings-panel", "#settings-btn"));
  $("#night-btn").addEventListener("click", () => togglePopover("#night-panel", "#night-btn"));
  $("#font-size").addEventListener("input", (e) => { settings.fontSize = Number(e.target.value); applySettings(); });
  $("#font-family").addEventListener("change", (e) => { settings.font = e.target.value; applySettings(); });
  document.querySelectorAll(".theme-row button").forEach((b) =>
    b.addEventListener("click", () => {
      settings.theme = settings.theme === b.dataset.theme ? "" : b.dataset.theme;
      applySettings();
    }),
  );

  // Bedtime panel
  $("#sleep-timer").addEventListener("change", (e) => setSleepTimer(e.target.value));
  $("#sound-select").addEventListener("change", (e) => sound.play(e.target.value));
  $("#sound-volume").addEventListener("input", (e) => {
    settings.soundVolume = Number(e.target.value);
    sound.setVolume(settings.soundVolume * fadeLevel());
    store.set("settings", settings);
  });
  $("#dim-btn").addEventListener("click", () => {
    dimScreen(true);
    if (!tts.playing) togglePlay();
  });
  $("#dim-overlay").addEventListener("click", () => dimScreen(false));

  // Read aloud
  $("#tts-play").addEventListener("click", togglePlay);
  $("#tts-stop").addEventListener("click", () => { stopSpeaking(); tts.index = -1; });
  $("#tts-rate").addEventListener("input", (e) => {
    settings.rate = Number(e.target.value);
    applySettings();
  });
  $("#tts-rate").addEventListener("change", () => {
    if (tts.playing && tts.mode === "book") speakFrom(tts.index); // apply new speed right away
  });
  $("#tts-voice").addEventListener("change", (e) => {
    settings.voice = e.target.value;
    applySettings();
    if (tts.playing && tts.mode === "book") speakFrom(tts.index);
  });
  if (synth) {
    populateVoices();
    synth.addEventListener?.("voiceschanged", populateVoices);
  } else {
    $("#tts-play").disabled = true;
    $("#tts-play").title = "Read aloud isn't supported in this browser";
  }

  // AI
  $("#ai-btn").addEventListener("click", () => toggleAiPanel());
  $("#ai-close").addEventListener("click", () => toggleAiPanel(false));
  document.querySelectorAll(".ai-quick button").forEach((b) =>
    b.addEventListener("click", () => askAi(b.dataset.action)),
  );
  $("#ai-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const q = $("#ai-input").value.trim();
    if (!q) return;
    $("#ai-input").value = "";
    askAi("ask", q);
  });

  // Story maker
  $("#story-form").addEventListener("submit", (e) => {
    e.preventDefault();
    writeStory();
  });
  $("#story-cancel").addEventListener("click", () => {
    storyAbort?.abort();
    $("#story-dialog").close();
  });
  $("#story-dialog").addEventListener("close", () => storyAbort?.abort());
  $("#story-ideas").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (b) $("#story-about").value = b.textContent;
  });

  document.addEventListener("keydown", (e) => {
    if ($("#reader-view").hidden || e.target.closest("input, select, textarea, dialog")) return;
    if (e.key === "ArrowRight") goToPage(state.page + 1);
    else if (e.key === "ArrowLeft") goToPage(state.page - 1);
    else if (e.key === " " && !e.target.closest("button")) { e.preventDefault(); togglePlay(); }
    else if (e.key === "Escape") { closePopovers(); toggleAiPanel(false); dimScreen(false); }
  });

  api("/api/status")
    .then((s) => {
      state.aiAvailable = s.ai;
      if (!s.ai) $("#ai-btn").title = "AI assistant (needs ANTHROPIC_API_KEY on the server)";
    })
    .catch(() => {});

  window.addEventListener("hashchange", route);
  route();
  runSearch();
}

init();
