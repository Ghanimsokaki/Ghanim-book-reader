// Small helpers that work both in the local Node server and in Vercel functions.
import zlib from "node:zlib";

export function sendJson(req, res, status, data, { cache } = {}) {
  let body = Buffer.from(JSON.stringify(data));
  const headers = { "Content-Type": "application/json; charset=utf-8", Vary: "Accept-Encoding" };
  if (cache && status === 200) headers["Cache-Control"] = cache;
  // Books can be several MB of text; gzip keeps them well under Vercel's response size limit.
  if (body.length > 1024 && /\bgzip\b/.test(req.headers["accept-encoding"] || "")) {
    body = zlib.gzipSync(body);
    headers["Content-Encoding"] = "gzip";
  }
  headers["Content-Length"] = body.length;
  res.writeHead(status, headers);
  res.end(body);
}

export async function readJsonBody(req, limit = 2_000_000) {
  // Vercel may have parsed the body already.
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === "string") return JSON.parse(req.body || "{}");
    if (Buffer.isBuffer(req.body)) return JSON.parse(req.body.toString("utf8") || "{}");
    return req.body;
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("Request too large"), { status: 413 });
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

export function getUrl(req) {
  return new URL(req.url, `http://${req.headers.host || "localhost"}`);
}

export function startEventStream(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();
  return (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

// Wraps a handler so unexpected errors become JSON errors instead of crashes.
export function handler(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (!err.status || err.status >= 500) console.error(err);
      if (!res.headersSent) sendJson(req, res, err.status || 500, { error: err.message || "Server error" });
      else res.end();
    }
  };
}
