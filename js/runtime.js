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
  function makeTts() {
    if (!("speechSynthesis" in window)) return null;
    const synth = window.speechSynthesis;
    const pickVoice = () => {
      const vs = synth.getVoices().filter((v) => /^es(-|_|$)/i.test(v.lang));
      const pref = ["es-CO", "es-MX", "es-US", "es-419", "es-ES"];
      return pref.map((p) => vs.find((v) => v.lang.replace("_", "-") === p)).find(Boolean) || vs[0] || null;
    };
    synth.getVoices();
    return {
      speak(text) {
        return new Promise((resolve) => {
          synth.cancel();
          const u = new SpeechSynthesisUtterance(text);
          const v = pickVoice();
          if (v) u.voice = v;
          u.lang = v ? v.lang : "es-CO";
          u.rate = 1.02;
          u.onend = u.onerror = () => resolve();
          synth.speak(u);
        });
      },
      stop() { synth.cancel(); },
    };
  }

  const cache = {};
  window.claude = {
    use(name) {
      if (!(name in cache)) {
        cache[name] =
          name === "sample" ? makeSample() :
          name === "dictation" ? Promise.resolve(makeDictation()) :
          name === "tts" ? Promise.resolve(makeTts()) :
          Promise.resolve(null);
      }
      return cache[name];
    },
  };
})();
