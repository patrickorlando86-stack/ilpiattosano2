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

// === Multilingua ===
const SUPPORTED = new Set(["it","en","es","zh"]);
const LANG_LABEL = { it: "italiano", en: "English", es: "español", zh: "简体中文" };

// Risposte locali (zero token) per saluti/grazie in base alla lingua
const QUICK = {
  it: { greet: "Ciao! Come posso aiutarti sull’alimentazione dei bimbi? 😊",
        thanks: "Di nulla! Vuoi un’idea per merenda o cena? 🍎" },
  en: { greet: "Hi! How can I help with kids’ nutrition? 😊",
        thanks: "You’re welcome! Want a snack or dinner idea? 🍎" },
  es: { greet: "¡Hola! ¿Cómo puedo ayudarte con la alimentación infantil? 😊",
        thanks: "¡De nada! ¿Quieres una idea para merienda o cena? 🍎" },
  zh: { greet: "你好！我可以如何帮助孩子的营养饮食？😊",
        thanks: "不客气！要不要一个加餐或晚餐的点子？🍎" }
};

const GREET_WORDS = ["ciao","buongiorno","buonasera","hey","hola","hello","hi","你好","嗨"];
const THANKS_WORDS = ["grazie","thanks","gracias","ok","谢谢"];

function localQuickReply(msg, lang) {
  const m = (msg || "").toLowerCase().trim();
  if (GREET_WORDS.includes(m)) return QUICK[lang].greet;
  if (THANKS_WORDS.includes(m)) return QUICK[lang].thanks;
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

    const body = JSON.parse(event.body || "{}");
    const rawLocale = (body.locale || "it").toString().slice(0,2).toLowerCase();
    const lang = SUPPORTED.has(rawLocale) ? rawLocale : "it";

    const message = (body.message || "").toString();
    if (!message.trim()) return { statusCode: 400, headers, body: JSON.stringify({ error: "Messaggio mancante" }) };
    if (message.length > 500) return { statusCode: 400, headers, body: JSON.stringify({ error: "Messaggio troppo lungo" }) };

    // Risposta locale gratis?
    const quick = localQuickReply(message, lang);
    if (quick) return { statusCode: 200, headers, body: JSON.stringify({ reply: quick }) };

    // Cache (stessa domanda entro 24h)
    const k = keyOf(message, lang);
    const cached = getCache(k);
    if (cached) return { statusCode: 200, headers, body: JSON.stringify({ reply: cached }) };

    // --- Prompt super-corto = meno token, nella lingua richiesta ---
    const systemPrompt =
      `Sei la Dott.ssa Serafina, nutrizionista pediatrica. ` +
      `Rispondi in ${LANG_LABEL[lang]} in 1–2 frasi (≤ ~35 parole), tono gentile e pratico, max 1 emoji. ` +
      `Niente diagnosi; suggerisci alternative semplici per bambini.`;

    // Chiamata OpenAI "mini" + pochi token
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...(process.env.OPENAI_ORG_ID ? { "OpenAI-Organization": process.env.OPENAI_ORG_ID } : {})
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: message }
        ],
        temperature: 0.5,
        max_tokens: 90
      })
    });

    if (!r.ok) {
      const detail = await r.text();
      let msg = "LLM error";
      try { msg = (JSON.parse(detail).error?.message) || msg; } catch {}
      return { statusCode: r.status, headers, body: JSON.stringify({ error: msg }) };
    }

    const data = await r.json();
    const reply = data?.choices?.[0]?.message?.content?.trim() || (lang === "it" ? "Puoi riformulare?" : "Please rephrase?");

    setCache(k, reply); // salva in cache
    return { statusCode: 200, headers, body: JSON.stringify({ reply }) };

  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e?.message || "Errore interno" }) };
  }
};
