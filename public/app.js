// Ghanim Book Reader - front end
const $ = (sel) => document.querySelector(sel);

const PAGE_CHARS = 3500; // roughly one screen of reading per "page"

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
  { fontSize: 19, font: "serif", theme: "", rate: 1, voice: "" },
  store.get("settings", {}),
);

const state = {
  book: null, // { key, id, title, author, cover, lang, text }
  paragraphs: [],
  pages: [], // [startIndex, endIndex)
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
  root.style.letterSpacing = "";
  $("#page").style.letterSpacing = settings.font === "dyslexic" ? "0.04em" : "";
  $("#page").style.wordSpacing = settings.font === "dyslexic" ? "0.12em" : "";
  $("#font-size").value = settings.fontSize;
  $("#font-family").value = settings.font;
  $("#tts-rate").value = settings.rate;
  $("#tts-rate-val").textContent = Number(settings.rate).toFixed(1) + "×";
  document.querySelectorAll(".theme-row button").forEach((b) =>
    b.setAttribute("aria-pressed", String(b.dataset.theme === settings.theme)),
  );
  store.set("settings", settings);
}

// ---------------------------------------------------------------- library
function coverEl(book) {
  if (book.cover) {
    return el("img", { class: "cover", src: book.cover, alt: "", loading: "lazy" });
  }
  return el("div", { class: "cover placeholder" }, book.title);
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
      progress != null
        ? el("div", { class: "progress-bar" }, el("span", { style: `width:${Math.round(progress * 100)}%` }))
        : null,
    ),
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
    $("#results-status").textContent = data.results.length
      ? `${data.count.toLocaleString()} books found · page ${page}`
      : "No books found. Try another search.";
    $("#prev-page").hidden = page <= 1;
    $("#next-page").hidden = !data.hasNext;
  } catch (err) {
    $("#results-status").textContent = "Couldn't reach the book catalog: " + err.message;
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
  return /^(chapter|book|part|act|scene|volume|letter|canto|stave)\b/i.test(p) ||
    (p === p.toUpperCase() && /[A-Z]/.test(p) && p.length < 60);
}

function paginate(paragraphs) {
  const pages = [];
  let start = 0;
  let chars = 0;
  paragraphs.forEach((p, i) => {
    // Start chapters on a fresh page when the current page already has content.
    if (i > start && (chars + p.length > PAGE_CHARS || (isHeading(p) && chars > PAGE_CHARS * 0.4))) {
      pages.push([start, i]);
      start = i;
      chars = 0;
    }
    chars += p.length;
  });
  if (start < paragraphs.length) pages.push([start, paragraphs.length]);
  return pages.length ? pages : [[0, 0]];
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
  pickDefaultVoice();
  showView("reader");
  renderPage();
  saveProgress();
}

async function openGutenberg(id) {
  const saved = store.get("shelf", []).find((s) => s.key === `g${id}`);
  showLoading("Downloading book…");
  try {
    const { meta, text } = await api(`/api/book/${id}`);
    loadBook(
      {
        key: `g${id}`,
        id,
        title: meta.title,
        author: meta.authors.join(", "),
        cover: meta.cover,
        lang: meta.languages[0] || "en",
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
  if (item.key.startsWith("g")) {
    location.hash = `#/book/${item.id}`;
  } else {
    const text = store.get("file:" + item.key, null);
    if (!text) {
      alert("This file isn't saved in your browser anymore. Please open it again.");
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

async function handleFile(file) {
  if (!file) return;
  const text = await file.text();
  const key = "f" + Date.now().toString(36);
  const title = file.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ");
  const book = { key, title, author: "Your file", cover: null, lang: navigator.language.slice(0, 2), text };
  const savedText = store.set("file:" + key, text);
  if (!savedText) {
    // Too big for browser storage - still readable, just not kept on the shelf.
    loadBook(book);
    showView("reader");
    return;
  }
  // Put it on the shelf first so the URL route can find it.
  const shelf = store.get("shelf", []).filter((s) => s.key !== key);
  shelf.unshift({ key, title, author: book.author, cover: null, lang: book.lang, page: 0, pages: 1, updated: Date.now() });
  store.set("shelf", shelf);
  location.hash = `#/file/${key}`;
}

function saveProgress() {
  const b = state.book;
  if (!b) return;
  let shelf = store.get("shelf", []).filter((s) => s.key !== b.key);
  shelf.unshift({
    key: b.key, id: b.id, title: b.title, author: b.author, cover: b.cover, lang: b.lang,
    page: state.page, pages: state.pages.length, updated: Date.now(),
  });
  // Keep the 12 most recent books; drop stored text for files that fall off the shelf.
  for (const old of shelf.slice(12)) if (old.key.startsWith("f")) store.remove("file:" + old.key);
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
    const node = el(isHeading(p) ? "h3" : "p", { "data-i": i, class: "clickable", title: "Click to read aloud from here" }, p);
    node.addEventListener("click", () => {
      if (window.getSelection().toString()) return; // don't hijack text selection
      speakFrom(i);
    });
    page.append(node);
  }
  page.scrollTop = 0;
  $("#page-info").textContent = `Page ${state.page + 1} of ${state.pages.length}`;
  $("#progress").value = state.page;
  $("#prev-btn").disabled = state.page === 0;
  $("#next-btn").disabled = state.page >= state.pages.length - 1;
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

// ---------------------------------------------------------------- read aloud (text to speech)
const synth = window.speechSynthesis;
const tts = { playing: false, index: -1, run: 0, mode: "book" };

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
    u.onend = next;
    u.onerror = (e) => {
      if (e.error !== "interrupted" && e.error !== "canceled") next();
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
  const run = ++tts.run;
  tts.playing = true;
  tts.mode = "book";
  tts.index = index;
  updateTtsButtons();

  // Turn the page automatically when the reader reaches the end of it.
  const pageOf = (i) => state.pages.findIndex(([s, e]) => i >= s && i < e);
  const p = pageOf(index);
  if (p !== -1 && p !== state.page) goToPage(p, { keepSpeaking: true });
  if (index >= state.paragraphs.length) return stopSpeaking();

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
  speakChunks(chunkText(text), run, stopSpeaking);
}

function stopSpeaking() {
  tts.run++;
  tts.playing = false;
  if (synth) synth.cancel();
  document.querySelectorAll("#page .speaking").forEach((n) => n.classList.remove("speaking"));
  updateTtsButtons();
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
  summarize: "Summarize this page",
  explain: "Explain this page simply",
  characters: "Who's who on this page?",
  vocab: "What are the hard words?",
};

async function askAi(action, question = "") {
  if (!state.aiAvailable) {
    addMsg("error", "The AI assistant isn't set up on this server yet. Start it with an ANTHROPIC_API_KEY to turn it on.");
    return;
  }
  const userText = action === "ask" ? question : QUICK_LABELS[action];
  addMsg("user", userText);
  const { msg, body } = addMsg("assistant", "Thinking…");
  const buttons = document.querySelectorAll("#ai-form button, .ai-quick button");
  buttons.forEach((b) => (b.disabled = true));

  let answer = "";
  try {
    const r = await fetch("/api/ai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action,
        question,
        text: currentPageText(),
        title: state.book.title,
        author: state.book.author,
        history: state.aiHistory,
      }),
    });
    if (!r.ok || !r.body) {
      const data = await r.json().catch(() => ({}));
      throw new Error(data.error || `Request failed (${r.status})`);
    }
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
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
        if (evt.error) throw new Error(evt.error);
        if (evt.text) {
          answer += evt.text;
          body.textContent = answer;
          $("#ai-log").scrollTop = $("#ai-log").scrollHeight;
        }
      }
    }
    if (!answer) throw new Error("No answer came back. Please try again.");
    state.aiHistory.push({ role: "user", content: userText }, { role: "assistant", content: answer });
    msg.append(el("button", { class: "speak", onclick: () => speakText(answer) }, "🔊 Read this answer aloud"));
  } catch (err) {
    msg.className = "msg error";
    body.textContent = answer ? answer + "\n\n⚠ " + err.message : err.message;
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}

function toggleAiPanel(force) {
  const panel = $("#ai-panel");
  const open = force ?? panel.hidden;
  panel.hidden = !open;
  $("#ai-btn").setAttribute("aria-expanded", String(open));
  if (open) $("#ai-input").focus();
}

// ---------------------------------------------------------------- views & routing
function showView(name) {
  $("#library-view").hidden = name !== "library";
  $("#reader-view").hidden = name !== "reader";
  $("#settings-panel").hidden = true;
  if (name === "library") {
    stopSpeaking();
    document.title = "Ghanim Book Reader";
    renderShelf();
  }
}

function route() {
  const m = location.hash.match(/^#\/(book|file)\/([\w-]+)/);
  if (!m) return showView("library");
  if (state.book && state.book.key === (m[1] === "book" ? `g${m[2]}` : m[2])) return showView("reader");
  if (m[1] === "book") openGutenberg(m[2]);
  else openLocalFile(m[2]);
}

// ---------------------------------------------------------------- wire up
function init() {
  applySettings();
  renderShelf();

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
  $("#prev-page").addEventListener("click", () => { state.search.page--; runSearch(); });
  $("#next-page").addEventListener("click", () => { state.search.page++; runSearch(); });
  $("#file-input").addEventListener("change", (e) => { handleFile(e.target.files[0]); e.target.value = ""; });

  $("#back-btn").addEventListener("click", () => (location.hash = ""));
  $("#prev-btn").addEventListener("click", () => goToPage(state.page - 1));
  $("#next-btn").addEventListener("click", () => goToPage(state.page + 1));
  $("#progress").addEventListener("change", (e) => goToPage(Number(e.target.value)));

  $("#settings-btn").addEventListener("click", () => {
    const p = $("#settings-panel");
    p.hidden = !p.hidden;
    $("#settings-btn").setAttribute("aria-expanded", String(!p.hidden));
  });
  $("#font-size").addEventListener("input", (e) => { settings.fontSize = Number(e.target.value); applySettings(); });
  $("#font-family").addEventListener("change", (e) => { settings.font = e.target.value; applySettings(); });
  document.querySelectorAll(".theme-row button").forEach((b) =>
    b.addEventListener("click", () => {
      settings.theme = settings.theme === b.dataset.theme ? "" : b.dataset.theme;
      applySettings();
    }),
  );

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

  document.addEventListener("keydown", (e) => {
    if ($("#reader-view").hidden || e.target.closest("input, select, textarea")) return;
    if (e.key === "ArrowRight") goToPage(state.page + 1);
    else if (e.key === "ArrowLeft") goToPage(state.page - 1);
    else if (e.key === " " && !e.target.closest("button")) { e.preventDefault(); togglePlay(); }
    else if (e.key === "Escape") { $("#settings-panel").hidden = true; toggleAiPanel(false); }
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
