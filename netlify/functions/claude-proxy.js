const https = require("https");

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

function callAnthropic(body, betaHeader) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const hdrs = {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Length": Buffer.byteLength(payload),
    };
    if (betaHeader) hdrs["anthropic-beta"] = betaHeader;
    const req = https.request(
      { hostname: "api.anthropic.com", path: "/v1/messages", method: "POST", headers: hdrs },
      (res) => {
        let data = "";
        res.on("data", c => data += c);
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on("error", reject);
    req.setTimeout(55000, () => { req.destroy(); reject(new Error("timeout")); });
    req.write(payload);
    req.end();
  });
}

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };

  if (!ANTHROPIC_API_KEY) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "ANTHROPIC_API_KEY não configurada no Netlify" }),
    };
  }

  try {
    const { messages, useWebSearch = false, maxTokens = 2000 } = JSON.parse(event.body || "{}");

    if (!Array.isArray(messages) || !messages.length) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "messages obrigatório" }) };
    }

    const tools = useWebSearch ? [{ type: "web_search_20250305", name: "web_search" }] : undefined;
    const betaHeader = useWebSearch ? "web-search-2025-03-05" : undefined;

    let msgs = [...messages];
    let finalText = "";

    for (let iter = 0; iter < 5; iter++) {
      const reqBody = {
        model: "claude-sonnet-4-6",
        max_tokens: maxTokens,
        messages: msgs,
        ...(tools ? { tools } : {}),
      };

      const res = await callAnthropic(reqBody, betaHeader);
      if (res.status !== 200) {
        let errMsg = `HTTP ${res.status}`;
        try { errMsg = JSON.parse(res.body).error?.message || errMsg; } catch (_) {}
        throw new Error(errMsg);
      }

      const data = JSON.parse(res.body);
      const textBlocks = (data.content || []).filter(b => b.type === "text");
      const toolUses   = (data.content || []).filter(b => b.type === "tool_use");

      if (data.stop_reason === "end_turn" || !toolUses.length) {
        finalText = textBlocks.map(b => b.text).join("\n").trim();
        break;
      }

      // Continue agentic loop: send tool results back so Claude can synthesize
      msgs = [
        ...msgs,
        { role: "assistant", content: data.content },
        {
          role: "user",
          content: toolUses.map(tu => ({
            type: "tool_result",
            tool_use_id: tu.id,
            content: "Search executed.",
          })),
        },
      ];

      // If partial text exists alongside tool_use, capture it as fallback
      if (!finalText && textBlocks.length) finalText = textBlocks.map(b => b.text).join("\n").trim();
    }

    return { statusCode: 200, headers, body: JSON.stringify({ text: finalText }) };

  } catch (e) {
    console.error("claude-proxy error:", e.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
