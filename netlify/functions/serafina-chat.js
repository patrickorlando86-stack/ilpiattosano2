// netlify/functions/serafina-chat.js
// CORS: consenti solo il tuo dominio PWA
const ALLOW = ["https://ilpiattosano.netlify.app"];
const cors = (origin) => ({
  "Access-Control-Allow-Origin": ALLOW.includes(origin) ? origin : ALLOW[0],
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Vary": "Origin",
  "Content-Type": "application/json"
});

// --- Cache & Rate limit in-memory (vale per istanze "calde") ---
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24h
const cache = globalThis.__serafinaCache || (globalThis.__serafinaCache = new Map());

const WINDOW_MS = 60 * 1000;  // 1 minuto
const MAX_PER_WINDOW = 5;     // max 5 richieste/min per IP
const hits = globalThis.__serafinaHits || (globalThis.__serafinaHits = new Map());

function keyOf(message, locale) {
  return (locale + "|" + message.trim().toLowerCase()).slice(0, 256);
}
function getCache(k) {
  const e = cache.get(k);
  return e && (Date.now() - e.t < CACHE_TTL) ? e.v : null;
}
function setCache(k, v) {
  cache.set(k, { v, t: Date.now() });
}
function tooMany(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter(ts => now - ts < WINDOW_MS);
  if (list.length >= MAX_PER_WINDOW) return true;
  list.push(now);
  hits.set(ip, list);
  return false;
}

// Risposte locali per saluti/grazie (zero chiamate all'API)
function localQuickReply(msg) {
  const m = msg.toLowerCase().trim();
  if (["ciao", "buongiorno", "buonasera", "hey", "hola"].includes(m)) {
    return "Ciao! Come posso aiutarti sull’alimentazione dei bimbi? 😊";
  }
  if (["grazie", "thanks", "ok"].includes(m)) {
    return "Di nulla! Se vuoi, chiedimi un’idea per merenda o cena. 🍎";
  }
  return null;
}

exports.handler = async (event) => {
  const headers = cors(event.headers.origin || "");

  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: JSON.stringify({ error: "Method Not Allowed" }) };

  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return { statusCode: 500, headers, body: JSON.stringify({ error: "Chiave OpenAI mancante lato server" }) };

    const ip = (event.headers["x-forwarded-for"] || "").split(",")[0] || "unknown";
    if (tooMany(ip)) return { statusCode: 429, headers, body: JSON.stringify({ error: "Troppi messaggi, attendi qualche secondo." }) };

    const { message, locale = "it" } = JSON.parse(event.body || "{}");
    if (!message || !message.trim()) return { statusCode: 400, headers, body: JSON.stringify({ error: "Messaggio mancante" }) };
    if (message.length > 500) return { statusCode: 400, headers, body: JSON.stringify({ error: "Messaggio troppo lungo" }) };

    // Risposta locale gratis?
    const quick = localQuickReply(message);
    if (quick) return { statusCode: 200, headers, body: JSON.stringify({ reply: quick }) };

    // Cache (stessa domanda entro 24h)
    const k = keyOf(message, locale);
    const cached = getCache(k);
    if (cached) return { statusCode: 200, headers, body: JSON.stringify({ reply: cached }) };

    // --- Prompt super-corto = meno token ---
    const systemPrompt = "Sei la Dott.ssa Serafina, nutrizionista pediatrica. Rispondi in italiano in 1–2 frasi, tono gentile e pratico, max ~35 parole, max 1 emoji. Niente diagnosi; suggerisci alternative semplici per bambini.";

    // Chiamata OpenAI "mini" + pochi token
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
        // Se usi più organizzazioni: "OpenAI-Organization": "org_XXXX"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: message }
        ],
        temperature: 0.5,
        max_tokens: 90  // abbassa l’output
      })
    });

    if (!r.ok) {
      const detail = await r.text();
      let msg = "LLM error";
      try { msg = (JSON.parse(detail).error?.message) || msg; } catch {}
      return { statusCode: r.status, headers, body: JSON.stringify({ error: msg }) };
    }

    const data = await r.json();
    const reply = data?.choices?.[0]?.message?.content?.trim() || "Puoi riformulare?";

    setCache(k, reply); // salva in cache
    return { statusCode: 200, headers, body: JSON.stringify({ reply }) };

  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e?.message || "Errore interno" }) };
  }
};
