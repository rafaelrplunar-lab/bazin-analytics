const https   = require("https");
const { randomUUID } = require("crypto");

const BASE_ID = process.env.AIRTABLE_BASE_ID;
const API_KEY = process.env.AIRTABLE_API_KEY;

// Nomes das tabelas e campos no Airtable (ajuste via env vars se necessário)
const T = {
  portfolio: process.env.AT_TABLE_PORTFOLIO || "Portfolio",
  watchlist: process.env.AT_TABLE_WATCHLIST || "Watchlist",
};
const F = {
  ticker:   process.env.AT_F_TICKER    || "Ticker",
  avgPrice: process.env.AT_F_AVG_PRICE || "Preco_Medio",
  qty:      process.env.AT_F_QTY       || "Quantidade",
};

function airtableReq(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api.airtable.com",
      path,
      method,
      headers: {
        "Authorization": `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("timeout")); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// Retorna null se a tabela não existir, lança erro em outros casos
async function listRecords(table) {
  const records = [];
  let offset = "";
  do {
    const qs = offset ? `?offset=${encodeURIComponent(offset)}` : "";
    const res = await airtableReq("GET", `/v0/${BASE_ID}/${encodeURIComponent(table)}${qs}`);
    if (res.status === 404 || res.status === 422) return null;
    if (res.status === 401 || res.status === 403) {
      throw new Error(`Airtable: API key inválida ou sem permissão (HTTP ${res.status})`);
    }
    const json = JSON.parse(res.body);
    if (json.error) {
      console.error(`listRecords [${table}]:`, json.error);
      return null;
    }
    records.push(...(json.records || []));
    offset = json.offset || "";
  } while (offset);
  return records;
}

async function deleteRecords(table, ids) {
  for (let i = 0; i < ids.length; i += 10) {
    const batch = ids.slice(i, i + 10);
    const qs = batch.map(id => `records[]=${id}`).join("&");
    await airtableReq("DELETE", `/v0/${BASE_ID}/${encodeURIComponent(table)}?${qs}`);
  }
}

async function createRecords(table, fieldsList) {
  for (let i = 0; i < fieldsList.length; i += 10) {
    const batch = fieldsList.slice(i, i + 10).map(f => ({ fields: f }));
    const res = await airtableReq("POST", `/v0/${BASE_ID}/${encodeURIComponent(table)}`, { records: batch });
    const json = JSON.parse(res.body);
    if (json.error) throw new Error(`createRecords [${table}]: ${json.error.message || JSON.stringify(json.error)}`);
  }
}

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };

  if (!BASE_ID || !API_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({
      error: "AIRTABLE_BASE_ID ou AIRTABLE_API_KEY não configurados"
    })};
  }

  // ── GET ?debug=true: diagnóstico da conexão ───────────────
  if (event.httpMethod === "GET" && event.queryStringParameters?.debug === "true") {
    const diag = {
      config: {
        base_id: BASE_ID ? BASE_ID.slice(0, 6) + "…" : "NÃO DEFINIDO",
        api_key: API_KEY ? "pat" + API_KEY.slice(3, 8) + "…" : "NÃO DEFINIDO",
        table_portfolio: T.portfolio,
        table_watchlist: T.watchlist,
        field_ticker:    F.ticker,
        field_avgPrice:  F.avgPrice,
        field_qty:       F.qty,
      },
    };
    try {
      const res = await airtableReq("GET", `/v0/${BASE_ID}/${encodeURIComponent(T.portfolio)}?maxRecords=1`);
      diag.portfolio_http = res.status;
      if (res.status === 200) {
        const json = JSON.parse(res.body);
        const rec = json.records?.[0];
        diag.portfolio_status = "OK";
        diag.portfolio_sample_fields = rec ? Object.keys(rec.fields) : "(tabela vazia)";
      } else if (res.status === 401 || res.status === 403) {
        diag.portfolio_status = "ERRO: API key inválida ou sem permissão";
      } else if (res.status === 404) {
        diag.portfolio_status = `ERRO: tabela "${T.portfolio}" não encontrada`;
      } else {
        diag.portfolio_status = `ERRO HTTP ${res.status}: ${res.body.slice(0, 200)}`;
      }
    } catch (e) {
      diag.portfolio_status = `EXCEÇÃO: ${e.message}`;
    }
    return { statusCode: 200, headers, body: JSON.stringify(diag, null, 2) };
  }

  try {
    // ── GET: carrega carteira e watchlist ─────────────────────
    if (event.httpMethod === "GET") {
      const [pRecs, wRecs] = await Promise.all([
        listRecords(T.portfolio),
        listRecords(T.watchlist),
      ]);

      console.log(`GET — ${T.portfolio} records:`, pRecs?.length ?? "tabela não encontrada");
      console.log(`GET — ${T.watchlist} records:`, wRecs?.length ?? "tabela não encontrada");

      const portfolio = (pRecs || []).map(r => ({
        id:       randomUUID(),
        ticker:   r.fields[F.ticker],
        avgPrice: r.fields[F.avgPrice],
        qty:      r.fields[F.qty] ?? null,
      })).filter(p => p.ticker && p.avgPrice);

      const watchlist = (wRecs || []).map(r => ({
        id:     randomUUID(),
        ticker: r.fields[F.ticker],
      })).filter(w => w.ticker);

      return { statusCode: 200, headers, body: JSON.stringify({ portfolio, watchlist }) };
    }

    // ── POST: salva carteira e watchlist (full replace) ───────
    if (event.httpMethod === "POST") {
      const { portfolio = [], watchlist = [] } = JSON.parse(event.body || "{}");

      console.log("POST — salvando portfolio:", portfolio.length, "watchlist:", watchlist.length);

      const [pRecs, wRecs] = await Promise.all([
        listRecords(T.portfolio),
        listRecords(T.watchlist),
      ]);

      // Portfolio — erro explícito se tabela não encontrada
      if (pRecs === null) {
        return { statusCode: 500, headers, body: JSON.stringify({
          error: `Tabela "${T.portfolio}" não encontrada no Airtable. Verifique o nome exato da tabela ou configure AT_TABLE_PORTFOLIO.`,
        })};
      }

      if (pRecs.length) await deleteRecords(T.portfolio, pRecs.map(r => r.id));
      if (portfolio.length) {
        await createRecords(T.portfolio, portfolio.map(p => ({
          [F.ticker]:   p.ticker,
          [F.avgPrice]: p.avgPrice,
          ...(p.qty != null ? { [F.qty]: p.qty } : {}),
        })));
      }
      console.log("Portfolio salvo:", portfolio.length, "registros");

      // Watchlist (opcional — pula se tabela não existir)
      if (wRecs !== null) {
        if (wRecs.length) await deleteRecords(T.watchlist, wRecs.map(r => r.id));
        if (watchlist.length) {
          await createRecords(T.watchlist, watchlist.map(w => ({
            [F.ticker]: w.ticker,
          })));
        }
        console.log("Watchlist salva:", watchlist.length, "registros");
      }

      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };

  } catch (e) {
    console.error("portfolio-data error:", e.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
