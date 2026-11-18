// Función serverless de Vercel: voz de Macondí con OpenAI (texto → audio mp3).
const MODEL = process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts";
const VOICE = process.env.OPENAI_TTS_VOICE || "coral";
const BASE_URL = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
const MAX_CHARS = 900;
const RATE_MAX = Number(process.env.TTS_RATE_LIMIT_MAX || 20);
const RATE_WINDOW = Number(process.env.RATE_LIMIT_WINDOW_MIN || 10) * 60_000;
const INSTRUCTIONS =
  "Habla en español latino con acento colombiano neutro, con tono cálido, cercano y natural, a un ritmo fluido y ágil, sin sonar robótica.";

const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW);
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 5000) hits.clear();
  return arr.length > RATE_MAX;
}

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

function originAllowed(request) {
  const allowed = (process.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!allowed.length) return true;
  const origin = request.headers.get("origin");
  return !origin || allowed.includes(origin);
}

export function GET() {
  return json(process.env.OPENAI_API_KEY ? 200 : 503, { ok: !!process.env.OPENAI_API_KEY });
}

// POST /api/tts  { text } → audio/mpeg
export async function POST(request) {
  if (!process.env.OPENAI_API_KEY) return json(503, { code: "capability_disabled" });
  if (!originAllowed(request)) return json(403, { code: "forbidden" });

  const ip = (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "anon";
  if (limited(ip)) return json(429, { code: "rate_limited" });

  let body;
  try { body = await request.json(); } catch { return json(400, { code: "bad_request" }); }
  const text = typeof body?.text === "string" ? body.text.replace(/\s+/g, " ").trim().slice(0, MAX_CHARS) : "";
  if (!text) return json(400, { code: "bad_request" });

  const upstream = await fetch(`${BASE_URL}/audio/speech`, {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, voice: VOICE, input: text, instructions: INSTRUCTIONS, response_format: "mp3" }),
  }).catch(() => null);

  if (!upstream || !upstream.ok || !upstream.body) {
    const detail = upstream ? await upstream.text().catch(() => "") : "network";
    console.error("OpenAI TTS error", upstream?.status || 0, detail.slice(0, 500));
    return json(upstream?.status === 429 ? 429 : 502, { code: "upstream_error" });
  }
  return new Response(upstream.body, {
    headers: { "content-type": "audio/mpeg", "cache-control": "no-store" },
  });
}
