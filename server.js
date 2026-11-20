// Local development server. On Vercel, files in ./public are served as static files
// and each file in ./api becomes a serverless function, so this file isn't used there.
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import search from "./api/search.js";
import book from "./api/book/[id].js";
import ai from "./api/ai.js";
import story from "./api/story.js";
import status from "./api/status.js";
import { anthropic, MODEL } from "./lib/ai.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(here, "public");
const PORT = Number(process.env.PORT) || 3000;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
};

const routes = [
  ["GET", /^\/api\/search$/, search],
  ["GET", /^\/api\/book\/[^/]+$/, book],
  ["POST", /^\/api\/ai$/, ai],
  ["POST", /^\/api\/story$/, story],
  ["GET", /^\/api\/status$/, status],
];

async function serveStatic(pathname, res) {
  let rel = decodeURIComponent(pathname);
  if (rel === "/") rel = "/index.html";
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
  }
}

http
  .createServer(async (req, res) => {
    const { pathname } = new URL(req.url, "http://localhost");
    const route = routes.find(([method, re]) => method === req.method && re.test(pathname));
    if (route) return route[2](req, res);
    if (pathname.startsWith("/api/")) {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Not found" }));
    }
    return serveStatic(pathname, res);
  })
  .listen(PORT, () => {
    console.log(`📚 Ghanim Book Reader running at http://localhost:${PORT}`);
    console.log(anthropic ? `🤖 AI assistant enabled (${MODEL})` : "🤖 AI assistant disabled - set ANTHROPIC_API_KEY to enable it");
  });
