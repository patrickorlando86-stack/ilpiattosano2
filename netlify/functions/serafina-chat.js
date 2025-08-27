// netlify/functions/serafina-chat.js

const ALLOWED_ORIGINS = [
  "https://ilpiattosano.netlify.app", // <-- PWA principale
];

function makeCorsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

exports.handler = async (event) => {
  const cors = makeCorsHeaders(event.headers.origin || "");

  // Preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: cors, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: cors, body: "Method Not Allowed" };
  }

  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return { statusCode: 500, headers: cors, body: JSON.stringify({ error: "Chiave OpenAI mancante lato server" }) };
    }

    const { message, locale = "it" } = JSON.parse(event.body || "{}");
    if (!message?.trim()) {
      return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "Messaggio mancante" }) };
    }

    const systemPrompt = `
Sei Serafina, nutrizionista pediatrica in una web app per bambini.
Rispondi in ${locale} con frasi brevi, pratiche e gentili (max 2 frasi).
Usa al massimo 1 emoji; evita diagnosi. Ricorda: 1/2 frutta/verdura, 1/4 cereali integrali, 1/4 proteine sane.
`.trim();

    const payload = {
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: message },
      ],
      temperature: 0.6,
      max_tokens: 160,
    };

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!r.ok) {
      const detail = await r.text();
      return { statusCode: 502, headers: cors, body: JSON.stringify({ error: "LLM error", detail: detail.slice(0,300) }) };
    }

    const data = await r.json();
    const reply = data?.choices?.[0]?.message?.content?.trim() || "Puoi riformulare?";
    return { statusCode: 200, headers: { ...cors, "Content-Type": "application/json" }, body: JSON.stringify({ reply }) };
  } catch (e) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: "Errore interno" }) };
  }
};
