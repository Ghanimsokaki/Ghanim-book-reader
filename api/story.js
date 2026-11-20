import { handleStory } from "../lib/ai.js";
import { handler } from "../lib/http.js";

// POST /api/story  { name, about, age, length }  ->  event stream of a new bedtime story
export default handler(handleStory);
