import { searchBooks } from "../lib/books.js";
import { getUrl, handler, sendJson } from "../lib/http.js";

// GET /api/search?q=&lang=&topic=&page=
export default handler(async (req, res) => {
  const url = getUrl(req);
  const data = await searchBooks({
    q: (url.searchParams.get("q") || "").trim(),
    page: Math.max(1, Number(url.searchParams.get("page")) || 1),
    lang: (url.searchParams.get("lang") || "").trim(),
    topic: (url.searchParams.get("topic") || "").trim(),
  });
  sendJson(req, res, 200, data, { cache: "public, s-maxage=3600, stale-while-revalidate=86400" });
});
