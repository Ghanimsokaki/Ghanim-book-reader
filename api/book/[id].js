import { getBook } from "../../lib/books.js";
import { getUrl, handler, sendJson } from "../../lib/http.js";

// GET /api/book/14838      ->  a Project Gutenberg book
// GET /api/book/OL123456W  ->  an Open Library book (text from the Internet Archive)
export default handler(async (req, res) => {
  const id = String(req.query?.id || getUrl(req).pathname.split("/").pop());
  const source = /^OL\d+W$/.test(id) ? "openlibrary" : "gutenberg";
  const book = await getBook(source, id);
  sendJson(req, res, 200, book, { cache: "public, s-maxage=604800, stale-while-revalidate=2592000" });
});
