const https = require("https");

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;

// Modelos 100% gratuitos no OpenRouter (sufixo :free — sem custo de tokens).
// Nenhum modelo free tem busca web nativa; por isso tentamos vários em
// sequência (eles têm rate limit agressivo e caem com frequência).
const FREE_MODELS = [
  "deepseek/deepseek-chat-v3.1:free",
  "meta-llama/llama-3.3-70b-instruct:free",
  "qwen/qwen-2.5-72b-instruct:free",
  "mistralai/mistral-7b-instruct:free",
];

function callOpenRouter(messages, model, maxTokens) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model, max_tokens: maxTokens, messages });
    const req = https.request(
      {
        hostname: "openrouter.ai",
        path: "/api/v1/chat/completions",
        method: "POST",
        headers: {
          "Authorization": `Bearer ${OPENROUTER_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://bazin-analytics.netlify.app",
          "X-Title": "Bazin Analytics",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", c => data += c);
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on("error", reject);
    req.setTimeout(55000, () => { req.destroy(); reject(new Error("timeout")); });
    req.write(body);
    req.end();
  });
}

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST")    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };

  if (!OPENROUTER_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({
      error: "OPENROUTER_API_KEY não configurada nas variáveis de ambiente do Netlify",
    })};
  }

  try {
    const { messages, maxTokens = 2000 } = JSON.parse(event.body || "{}");

    if (!Array.isArray(messages) || !messages.length) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "messages obrigatório" }) };
    }

    // Tenta os modelos free em sequência — eles têm rate limit agressivo
    // (compartilhado entre todos os usuários do OpenRouter) e caem com frequência.
    let lastErr = null;
    for (const model of FREE_MODELS) {
      try {
        console.log(`claude-proxy: tentando model=${model} msgs=${messages.length}`);
        const res = await callOpenRouter(messages, model, maxTokens);

        if (res.status === 429 || res.status === 404 || res.status === 503) {
          lastErr = new Error(`${model}: HTTP ${res.status} (indisponível/limite atingido)`);
          console.warn(lastErr.message);
          continue;
        }

        if (res.status !== 200) {
          let errMsg = `${model}: HTTP ${res.status}`;
          try { errMsg = `${model}: ${JSON.parse(res.body).error?.message || errMsg}`; } catch (_) {}
          lastErr = new Error(errMsg);
          console.warn(lastErr.message);
          continue;
        }

        const data = JSON.parse(res.body);
        const text = data.choices?.[0]?.message?.content?.trim() || "";
        if (!text) { lastErr = new Error(`${model}: resposta vazia`); continue; }

        return { statusCode: 200, headers, body: JSON.stringify({ text, model }) };
      } catch (e) {
        lastErr = e;
        console.warn(`${model} falhou:`, e.message);
      }
    }

    throw lastErr || new Error("Todos os modelos gratuitos falharam");

  } catch (e) {
    console.error("claude-proxy error:", e.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
