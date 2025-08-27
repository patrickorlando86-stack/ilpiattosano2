// netlify/functions/serafina-chat.js

exports.handler = async (event, context) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    // 1) Chiave presente?
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      console.error('❌ OPENAI_API_KEY non trovata nelle env Netlify');
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'Chiave OpenAI mancante lato server' })
      };
    }

    // 2) Input valido?
    const { message, locale = 'it' } = JSON.parse(event.body || '{}');
    if (!message || !message.trim()) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Messaggio mancante' }) };
    }

    // 3) Prompt di ruolo
    const systemPrompt = `
Sei Serafina, nutrizionista pediatrica in una web app per bambini.
Rispondi in ${locale} con frasi brevi, pratiche e gentili (massimo 2 frasi).
Usa al massimo 1 emoji quando serve. Evita diagnosi cliniche.
Ricorda la regola del piatto: 1/2 frutta/verdura, 1/4 cereali integrali, 1/4 proteine sane.
`;

    // 4) Chiamata OpenAI
    const payload = {
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt.trim() },
        { role: 'user', content: message }
      ],
      max_tokens: 160,
      temperature: 0.6
    };

    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    // 5) Errori dall’API
    if (!resp.ok) {
      const errText = await resp.text();
      console.error('❌ OpenAI non OK:', resp.status, errText);
      return {
        statusCode: 502,
        body: JSON.stringify({ error: `LLM error ${resp.status}` })
      };
    }

    const data = await resp.json();
    const reply = data?.choices?.[0]?.message?.content?.trim();

    if (!reply) {
      console.error('⚠️ Nessun contenuto nella risposta OpenAI:', JSON.stringify(data));
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reply: 'Mi sfugge qualcosa, puoi riformulare?' })
      };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reply })
    };

  } catch (error) {
    console.error('🔥 Errore function:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Errore interno' })
    };
  }
};
