# 📚 Ghanim Book Reader

A free ebook place where you can **search**, **read**, have the book **read aloud to you**, and ask an **AI reading assistant** about what you're reading.

## Features

- **Search 70,000+ free ebooks**: uses the [Gutendex](https://gutendex.com) API for Project Gutenberg's public-domain library. Search by title or author, filter by language, or browse topics (Adventure, Sci-fi, Mystery…).
- **Comfortable reader**: books are split into pages, with adjustable text size, serif, sans-serif or easy-read fonts, and Light, Sepia and Dark themes. Use the arrow keys to turn pages.
- **Read to me (text to speech)**: press ▶ or the space bar and the app reads the book aloud. It highlights the paragraph being read and turns pages for you. You can pick a voice and a speed, or click any paragraph to start reading from there. It uses your browser's built-in voices, so it's free and needs no key.
- **✨ AI reading assistant**: summarizes the page, explains it simply, tells you who's who, defines hard words, or answers any question you type. Answers stream in, and you can have each one read aloud.
- **Continue reading**: your recent books and the page you were on are saved in your browser.
- **Open your own `.txt` files**: read any plain-text book you already have.

## Run it

You need [Node.js](https://nodejs.org) 18 or newer.

```bash
npm install
```

```bash
npm start
```

Then open http://localhost:3000.

### Turn on the AI assistant

The assistant uses Claude. Get an API key from https://console.anthropic.com and start the server with it:

```bash
ANTHROPIC_API_KEY=your-key-here npm start
```

Without a key, everything else (search, reading, read-aloud) still works. The assistant just shows a message saying it isn't set up.

Optional settings (environment variables):

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3000` | Port the server listens on |
| `AI_MODEL` | `claude-opus-5-5` | Claude model used by the assistant |

## How it works

```
public/        the web app (HTML, CSS, JavaScript; no build step)
server.js      small Node server:
  GET  /api/search?q=&lang=&topic=&page=   search the Gutenberg catalog
  GET  /api/book/:id                       download a book's text (boilerplate removed)
  POST /api/ai                             stream an AI answer about a passage
  GET  /api/status                         is the AI assistant enabled?
```

The server downloads books for the browser because Project Gutenberg's files can't be fetched directly from a web page, and it keeps the AI key private on the server.
