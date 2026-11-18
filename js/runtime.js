// Adaptador para Vercel: reemplaza las funciones que la página usaba dentro de claude.ai
// (window.claude.use("sample" | "dictation" | "tts")) con la misma interfaz:
//   sample    → /api/chat (OpenAI, en el servidor)
//   dictation → Web Speech API del navegador (gratis)
//   tts       → speechSynthesis del navegador (gratis)
(() => {
  const err = (code, text) => Object.assign(new Error(code), { code, text });

  // ---------- IA: /api/chat ----------
  async function makeSample() {
    try {
      const r = await fetch("/api/chat", { method: "GET", cache: "no-store" });
      if (!r.ok) return null;
    } catch { return null; }

    return async function sample(messages, opts = {}) {
      let r;
      try {
        r = await fetch("/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ messages }),
        });
      } catch { throw err("network"); }
      if (!r.ok) {
        let code = "upstream_error";
        try { code = (await r.json()).code || code; } catch {}
        throw err(code);
      }
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let text = "";
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          text += dec.decode(value, { stream: true });
          opts.onText && opts.onText({ text });
        }
      } catch { throw err("stream_error", text); }
      if (!text.trim()) throw err("empty");
      return { text };
    };
  }

  // ---------- Dictado: Web Speech API ----------
  function makeDictation() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return null;
    const L = { partial: [], final: [], state: [] };
    const emit = (k, v) => L[k].forEach((f) => { try { f(v); } catch {} });
    let rec = null, state = "idle";
    const setState = (s) => { state = s; emit("state", { state: s }); };

    return {
      onPartial: (f) => L.partial.push(f),
      onFinal: (f) => L.final.push(f),
      onState: (f) => L.state.push(f),
      start() {
        return new Promise((resolve, reject) => {
          if (rec) { try { rec.abort(); } catch {} }
          rec = new SR();
          rec.lang = "es-CO";
          rec.interimResults = true;
          rec.continuous = true;
          let started = false;
          setState("starting");
          rec.onstart = () => { started = true; setState("listening"); resolve(); };
          rec.onresult = (e) => {
            let interim = "";
            for (let i = e.resultIndex; i < e.results.length; i++) {
              const t = e.results[i][0].transcript;
              if (e.results[i].isFinal) emit("final", { text: t.trim() + " " });
              else interim += t;
            }
            emit("partial", { text: interim });
          };
          rec.onerror = (e) => {
            const map = { "not-allowed": "not_granted", "service-not-allowed": "not_granted", "aborted": "stopped", "no-speech": "stopped", "audio-capture": "unavailable", "network": "unavailable" };
            if (!started) reject(err(map[e.error] || "failed"));
          };
          rec.onend = () => { rec = null; setState("idle"); if (!started) reject(err("stopped")); };
          try { rec.start(); } catch { setState("idle"); reject(err("failed")); }
        });
      },
      async stop() {
        if (rec && state !== "idle") { setState("finishing"); rec.stop(); }
      },
    };
  }

  // ---------- Voz: speechSynthesis ----------
  function makeBrowserTts() {
    if (!("speechSynthesis" in window)) return null;
    const synth = window.speechSynthesis;
    // Prefiere voces naturales (neuronales/premium) y español latino; evita las robóticas.
    const NATURAL = /natural|neural|premium|enhanced|mejorada|online|google|siri/i;
    const GOOD = /paulina|monica|mónica|sabina|dalia|salome|salomé|jorge|diego|gonzalo|elena|helena|lucia|lucía|paloma|google/i;
    const REGION = ["es-CO", "es-MX", "es-US", "es-419", "es-AR", "es-ES"];
    const score = (v) => {
      const lang = v.lang.replace("_", "-");
      const r = REGION.indexOf(lang);
      return (NATURAL.test(v.name) ? 100 : 0) + (GOOD.test(v.name) ? 40 : 0) + (r >= 0 ? 10 - r : 0) + (v.localService ? 0 : 5);
    };
    const pickVoice = () => {
      const vs = synth.getVoices().filter((v) => /^es(-|_|$)/i.test(v.lang));
      return vs.sort((x, y) => score(y) - score(x))[0] || null;
    };
    synth.getVoices();
    // Divide en frases: suena más fluido y evita que Chrome corte textos largos.
    const chunks = (t) =>
      (t.replace(/\s+/g, " ").match(/[^.!?¿¡:;]+[.!?:;]?/g) || [t]).map((x) => x.trim()).filter(Boolean);
    return {
      speak(text) {
        return new Promise((resolve) => {
          synth.cancel();
          const v = pickVoice();
          const parts = chunks(text);
          parts.forEach((part, i) => {
            const u = new SpeechSynthesisUtterance(part);
            if (v) u.voice = v;
            u.lang = v ? v.lang : "es-CO";
            u.rate = 1.08;
            u.pitch = 1.0;
            u.onend = u.onerror = () => { if (i === parts.length - 1) resolve(); };
            synth.speak(u);
          });
        });
      },
      stop() { synth.cancel(); },
    };
  }

  // ---------- Voz: OpenAI (/api/tts) con respaldo en la voz del navegador ----------
  async function makeTts() {
    const fallback = makeBrowserTts();
    let remote = false;
    try { remote = (await fetch("/api/tts", { method: "GET", cache: "no-store" })).ok; } catch {}
    if (!remote) return fallback;

    let audio = null, ctrl = null, url = null;
    const cleanup = () => { if (audio) { audio.pause(); audio = null; } if (url) { URL.revokeObjectURL(url); url = null; } };
    return {
      async speak(text) {
        this.stop();
        ctrl = new AbortController();
        const mine = ctrl;
        try {
          const r = await fetch("/api/tts", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text }),
            signal: mine.signal,
          });
          if (!r.ok) throw new Error("tts " + r.status);
          const blob = await r.blob();
          if (mine.signal.aborted) return;
          url = URL.createObjectURL(blob);
          audio = new Audio(url);
          const a = audio;
          await new Promise((resolve, reject) => {
            a.onended = resolve;
            a.onerror = () => reject(new Error("audio"));
            a.play().catch(reject);
          });
          cleanup();
        } catch (e) {
          if (mine.signal.aborted) return;
          cleanup();
          if (fallback) return fallback.speak(text); // si OpenAI falla, usa la voz del navegador
        }
      },
      stop() {
        if (ctrl) { ctrl.abort(); ctrl = null; }
        cleanup();
        if (fallback) fallback.stop();
      },
    };
  }

  const cache = {};
  window.claude = {
    use(name) {
      if (!(name in cache)) {
        cache[name] =
          name === "sample" ? makeSample() :
          name === "dictation" ? Promise.resolve(makeDictation()) :
          name === "tts" ? makeTts() :
          Promise.resolve(null);
      }
      return cache[name];
    },
  };
})();
