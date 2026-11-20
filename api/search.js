import { searchBooks } from "../lib/books.js";
import { getUrl, handler, sendJson } from "../lib/http.js";

// GET /api/search?q=&lang=&topic=&page=&source=all|gutenberg|openlibrary
export default handler(async (req, res) => {
  const url = getUrl(req);
  const source = ["gutenberg", "openlibrary"].includes(url.searchParams.get("source")) ? url.searchParams.get("source") : "all";
  const data = await searchBooks({
    q: (url.searchParams.get("q") || "").trim().slice(0, 200),
    page: Math.min(50, Math.max(1, Number(url.searchParams.get("page")) || 1)),
    lang: (url.searchParams.get("lang") || "").trim(),
    topic: (url.searchParams.get("topic") || "").trim().slice(0, 60),
    source,
  });
  // Cache full results for an hour; partial results (one library down) only briefly.
  const cache = data.warnings.length ? "public, s-maxage=120" : "public, s-maxage=3600, stale-while-revalidate=86400";
  sendJson(req, res, 200, data, { cache });
});
