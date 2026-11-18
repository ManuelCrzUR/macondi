// Función serverless de Vercel: chat de Macondí sobre la API de OpenAI.
// La API key y las instrucciones del agente viven solo en el servidor.
import { RULES } from "./_lib/prompt.js";

const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const BASE_URL = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
const MAX_TURNS = 12;          // mensajes de historial que se envían al modelo
const MAX_CHARS = 1500;        // largo máximo de cada mensaje
const RATE_MAX = Number(process.env.RATE_LIMIT_MAX || 25);        // mensajes por IP...
const RATE_WINDOW = Number(process.env.RATE_LIMIT_WINDOW_MIN || 10) * 60_000; // ...en esta ventana

// Límite simple en memoria (por instancia). Suficiente para frenar abuso casual;
// para algo estricto usa Upstash/Vercel KV (ver README).
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

// GET /api/chat → la página pregunta si el agente IA está disponible.
export function GET() {
  return json(process.env.OPENAI_API_KEY ? 200 : 503, { ok: !!process.env.OPENAI_API_KEY });
}

// POST /api/chat  { messages: [{role:"user"|"assistant", content}] } → texto en streaming
export async function POST(request) {
  if (!process.env.OPENAI_API_KEY) return json(503, { code: "capability_disabled" });
  if (!originAllowed(request)) return json(403, { code: "forbidden" });

  const ip = (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "anon";
  if (limited(ip)) return json(429, { code: "rate_limited" });

  let body;
  try { body = await request.json(); } catch { return json(400, { code: "bad_request" }); }
  const messages = (Array.isArray(body?.messages) ? body.messages : [])
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .slice(-MAX_TURNS)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_CHARS) }));
  if (!messages.length || messages[messages.length - 1].role !== "user") return json(400, { code: "bad_request" });

  const upstream = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      stream: true,
      max_completion_tokens: 700,
      messages: [{ role: "system", content: RULES }, ...messages],
    }),
  }).catch(() => null);

  if (!upstream || !upstream.ok || !upstream.body) {
    const status = upstream?.status || 0;
    const detail = upstream ? await upstream.text().catch(() => "") : "network";
    console.error("OpenAI error", status, detail.slice(0, 500));
    return json(status === 429 ? 429 : 502, { code: status === 429 ? "rate_limited" : "upstream_error" });
  }

  // Convierte el SSE de OpenAI en texto plano (solo los fragmentos de la respuesta).
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  const stream = new ReadableStream({
    async start(controller) {
      const reader = upstream.body.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let nl;
          while ((nl = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (data === "[DONE]") continue;
            try {
              const delta = JSON.parse(data).choices?.[0]?.delta?.content;
              if (delta) controller.enqueue(encoder.encode(delta));
            } catch { /* fragmento incompleto: se ignora */ }
          }
        }
      } catch (e) {
        console.error("stream error", e);
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" },
  });
}
