# Macondí: deploy en Vercel

Página estática con una función serverless que habla con la API de OpenAI.

```
index.html          ← la página (tienda + agente)
img/                ← imágenes
js/runtime.js       ← adaptador: chat → /api/chat, micrófono y voz → navegador
api/chat.js         ← función de Vercel que llama a OpenAI (streaming)
api/tts.js          ← función de Vercel: voz con OpenAI (mp3)
api/_lib/prompt.js  ← instrucciones del agente (solo en el servidor)
api/_lib/candles.js ← catálogo de velas que usa el agente
```

## Subirlo

**Opción A: con GitHub (recomendada)**
1. Crea un repo, sube esta carpeta y en vercel.com → *Add New → Project* importa el repo.
2. Framework Preset: **Other**. No hace falta build command ni output directory.
3. En *Settings → Environment Variables* agrega `OPENAI_API_KEY` (y opcionalmente las demás de `.env.example`).
4. Haz *Deploy*. Si agregas la variable después del primer deploy, vuelve a desplegar.

**Opción B: con la CLI**
```bash
npm i -g vercel
vercel                          # primer deploy (preview)
vercel env add OPENAI_API_KEY   # pega tu key
vercel --prod
```

Para probarlo en tu computador: copia `.env.example` como `.env.local`, pon tu key y corre `vercel dev`.

## Variables de entorno

| Variable | Obligatoria | Para qué |
|---|---|---|
| `OPENAI_API_KEY` | Sí | Tu key de OpenAI. Nunca llega al navegador. |
| `OPENAI_MODEL` | No | Modelo de chat. Por defecto `gpt-4o-mini`. |
| `ALLOWED_ORIGINS` | Recomendada | Tus dominios separados por coma, para que otros sitios no usen tu API. |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MIN` | No | Límite por IP. Por defecto 25 mensajes cada 10 minutos. |

## Cómo funciona

- **Chat con IA:** `/api/chat` agrega las instrucciones de Macondí, manda los últimos 12 mensajes a OpenAI y devuelve la respuesta en streaming.
- **Sin API key, o si OpenAI falla:** la página pasa sola a "Modo básico" (recomendaciones por palabras clave), así nunca queda rota.
- **Micrófono:** usa el reconocimiento de voz del navegador (Chrome, Edge y Safari). En Firefox el botón muestra un aviso.
- **Leer en voz alta:** usa la voz de OpenAI (`/api/tts`, modelo `gpt-4o-mini-tts`, voz `coral` por defecto; cambia con `OPENAI_TTS_VOICE`). Si falla o no hay key, usa la voz del navegador (gratis). También tiene límite por IP (`TTS_RATE_LIMIT_MAX`, 20 cada 10 min).

## Notas

- Lo único que cuesta es el chat, y lo cobra OpenAI por uso. Pon un límite de gasto mensual en platform.openai.com → *Limits*.
- El límite por IP vive en memoria y Vercel puede reiniciarlo. Si el sitio recibe mucho tráfico, cámbialo por Upstash Redis (`@upstash/ratelimit`).
