const https = require("https");

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;

// Para análise/chat puro (sem internet): modelo Claude rápido
// Para busca web em tempo real: Perplexity Sonar (nativo no OpenRouter)
const MODEL_DEFAULT   = "anthropic/claude-sonnet-4-5";
const MODEL_WEBSEARCH = "perplexity/sonar-pro";

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
    const { messages, useWebSearch = false, maxTokens = 2000 } = JSON.parse(event.body || "{}");

    if (!Array.isArray(messages) || !messages.length) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "messages obrigatório" }) };
    }

    const model = useWebSearch ? MODEL_WEBSEARCH : MODEL_DEFAULT;
    console.log(`claude-proxy: model=${model} msgs=${messages.length}`);

    const res = await callOpenRouter(messages, model, maxTokens);

    if (res.status !== 200) {
      let errMsg = `OpenRouter HTTP ${res.status}`;
      try { errMsg = JSON.parse(res.body).error?.message || errMsg; } catch (_) {}
      throw new Error(errMsg);
    }

    const data  = JSON.parse(res.body);
    const text  = data.choices?.[0]?.message?.content?.trim() || "";

    return { statusCode: 200, headers, body: JSON.stringify({ text }) };

  } catch (e) {
    console.error("claude-proxy error:", e.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
