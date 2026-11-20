import { anthropic, MODEL } from "../lib/ai.js";
import { handler, sendJson } from "../lib/http.js";

// GET /api/status  ->  is the AI assistant enabled?
export default handler(async (req, res) => {
  sendJson(req, res, 200, { ai: Boolean(anthropic), model: MODEL });
});
