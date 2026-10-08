// Zero-dependency server: serves the game and proxies Jev calls so the API key stays server-side.
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, "public");

// Minimal .env loader (KEY=value per line).
const envPath = path.join(ROOT, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const API_KEY = process.env.TYPESAFE_API_KEY;
const MODEL = process.env.TYPESAFE_MODEL || "jev-latest";
const PORT = Number(process.env.PORT || 3000);
const API_URL = "https://api.typesafe.ai/v1/systemone";

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

function send(res, status, body, type = "application/json") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function readJson(req) {
  let data = "";
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 1e6) throw new Error("body too large");
  }
  return JSON.parse(data);
}

async function proxyJev(req, res) {
  if (!API_KEY) return send(res, 500, { error: "TYPESAFE_API_KEY is not set. Add it to .env and restart." });
  let body;
  try {
    body = await readJson(req);
  } catch {
    return send(res, 400, { error: "invalid JSON" });
  }
  const payload = { model: MODEL, state: body.state, questions: body.questions };
  const started = performance.now();
  const attempts = []; // failed attempts before the final one, surfaced in the UI
  let last;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 200 * 2 ** (i - 1)));
    const t0 = performance.now();
    last = await callJev(payload);
    last.latency_ms = Math.round(performance.now() - t0);
    if (last.ok || !isTransient(last)) break;
    attempts.push({ status: last.status, error: last.response?.detail ?? last.error, latency_ms: last.latency_ms });
  }
  if (last.ok) attempts.length && console.log(`recovered after ${attempts.length} retr${attempts.length > 1 ? "ies" : "y"}`);
  else console.warn("Jev call failed:", last.status, JSON.stringify(last.response ?? last.error));
  send(res, 200, {
    ...last,
    latency_ms: last.latency_ms, // the successful (or final) attempt
    total_ms: Math.round(performance.now() - started),
    retries: attempts,
    request: payload,
  });
}

const MAX_ATTEMPTS = 4;

async function callJev(payload) {
  try {
    const r = await fetch(API_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const text = await r.text();
    let response;
    try {
      response = JSON.parse(text);
    } catch {
      response = { raw: text };
    }
    return { ok: r.ok, status: r.status, response };
  } catch (err) {
    return { ok: false, status: 0, error: String(err) };
  }
}

// Rate limits, overloads, server errors, network failures, and "model_unavailable" are worth retrying;
// bad keys (401) and invalid requests (422) are not.
function isTransient({ status, response }) {
  return status === 0 || status === 429 || status >= 500 || response?.detail?.error_type === "model_unavailable";
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "POST" && url.pathname === "/api/jev") return proxyJev(req, res);
    if (url.pathname === "/api/config") return send(res, 200, { hasKey: Boolean(API_KEY), model: MODEL });

    const file = path.normalize(path.join(PUBLIC, url.pathname === "/" ? "index.html" : url.pathname));
    if (!file.startsWith(PUBLIC)) return send(res, 403, "forbidden", "text/plain");
    fs.readFile(file, (err, data) => {
      if (err) return send(res, 404, "not found", "text/plain");
      send(res, 200, data, TYPES[path.extname(file)] || "application/octet-stream");
    });
  })
  .listen(PORT, () => {
    console.log(`Snake × Jev running at http://localhost:${PORT}  (model: ${MODEL}, key: ${API_KEY ? "loaded" : "MISSING"})`);
  });
