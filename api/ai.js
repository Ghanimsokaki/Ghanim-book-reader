import { handleAssistant } from "../lib/ai.js";
import { handler } from "../lib/http.js";

// POST /api/ai  { action, question, text, title, author, history }  ->  event stream
export default handler(handleAssistant);
