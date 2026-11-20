import { getBook } from "../../lib/books.js";
import { getUrl, handler, sendJson } from "../../lib/http.js";

// GET /api/book/:id  ->  { meta, text }
export default handler(async (req, res) => {
  const id = req.query?.id || getUrl(req).pathname.split("/").pop();
  const book = await getBook(id);
  sendJson(req, res, 200, book, { cache: "public, s-maxage=604800, stale-while-revalidate=2592000" });
});
