# 📚 Ghanim Book Reader

A free ebook place to **search**, **read**, have the book **read aloud to you**, and ask an **AI reading assistant** about it. It's made to be just right for **bedtime stories**.

## 🌙 Bedtime features

- **Bedtime mode**: night colors with warm text that's easy on sleepy eyes, a twinkling starry sky, and a calmer, slower, softer voice.
- **Bedtime story shelf**: hand-picked classics such as Peter Rabbit, The Velveteen Rabbit, Just So Stories, Grimm and Andersen fairy tales, and Aesop's Fables.
- **✨ Make up a new story**: the AI writes a brand-new, gentle bedtime story starring your child. You choose their name, what it's about, their age and how long it is. The story opens in the reader and starts reading aloud.
- **Sleep timer**: stop after 5 to 60 minutes, or "at the end of this story". In the last minute the voice and sounds fade out gently, then the screen goes dark with "Sweet dreams 🌙".
- **Soft sounds**: gentle rain, ocean waves or a soft hum, made in the browser (nothing to download), with their own volume.
- **Dim the screen**: keeps reading with a dark screen; tap to wake it. The screen is kept from locking while reading, so phones don't stop mid-story.
- **Jump to a story**: collections like Grimm's Fairy Tales get a menu listing every story.
- **🧸 Retell for little ones**: the AI retells the current page in simple words for a young child, ready to read aloud.

## 📖 Everything else

- **Two big free libraries, searched together**:
  - [Project Gutenberg](https://www.gutenberg.org), through the [Gutendex](https://gutendex.com) API, has 70,000+ clean ebooks.
  - [Open Library](https://openlibrary.org) has hundreds of thousands of public-domain books, read from the [Internet Archive](https://archive.org)'s scans.

  You can filter by library, language and topic. Each book shows which library it comes from.
- **Keeps working when a library is down**: if one library is slow or offline, search still shows results from the other, and Gutenberg books download from the official mirror (gutenberg.pglaf.org). A library that just failed is skipped for a few minutes, so visitors don't keep waiting for it.
- **Comfortable reader**: pages, text size, an easy-read font, and Light, Sepia, Dark and Night themes. Use the arrow keys to turn pages.
- **Read to me**: press ▶ or the space bar. It highlights the paragraph being read and turns pages for you. Pick a voice and speed, or tap any paragraph to start there. It uses your browser's built-in voices, so it's free.
- **AI reading assistant**: summarize the page, explain it simply, who's who, hard words, or ask anything.
- **Continue reading**: recent books, made-up stories, and the page you were on are saved in your browser.
- **Open your own `.txt` files.**

## 🚀 Deploy to Vercel

1. In Vercel, click **Add New → Project** and import this GitHub repository. No settings need changing: `vercel.json` already tells Vercel to serve `public/` and turn `api/` into functions.
2. To turn on the AI features, open **Settings → Environment Variables**, add `ANTHROPIC_API_KEY` with your key from https://console.anthropic.com, and redeploy.

Or from the command line:

```bash
npx vercel
```

Without a key, everything except the AI features (searching, reading, read-aloud, sleep timer, sounds) still works.

## 💻 Run it on your computer

You need [Node.js](https://nodejs.org) 20 or newer.

```bash
npm install
```

```bash
ANTHROPIC_API_KEY=your-key-here npm start
```

Then open http://localhost:3000.

Optional environment variables:

| Variable | Default | What it does |
|---|---|---|
| `ANTHROPIC_API_KEY` | none | Turns on the AI assistant and story maker |
| `AI_MODEL` | `claude-opus-5-5` | Claude model used for the AI features |
| `PORT` | `3000` | Port for the local server |

## How it works

```
public/            the web app (HTML, CSS, JavaScript; no build step)
api/               one file per endpoint (Vercel functions)
  search.js        GET  /api/search?q=&lang=&topic=&page=&source=   search Gutenberg + Open Library
  book/[id].js     GET  /api/book/14838 or /api/book/OL123W      a book's text, cleaned up
  ai.js            POST /api/ai                             streamed answer about a passage
  story.js         POST /api/story                          streamed new bedtime story
  status.js        GET  /api/status                         are the AI features on?
lib/               code shared by the endpoints
server.js          local development server that serves public/ and api/
```

The server downloads books for the browser because the libraries' files can't be fetched directly from a web page, and it keeps the AI key private. Search results and books are cached by Vercel's CDN, so popular books open quickly.
