const https = require("https");

const BASE_ID = process.env.AIRTABLE_BASE_ID;
const API_KEY = process.env.AIRTABLE_API_KEY;

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

async function listRecords(table) {
  const records = [];
  let offset = "";
  do {
    const qs = offset ? `?offset=${encodeURIComponent(offset)}` : "";
    const res = await airtableReq("GET", `/v0/${BASE_ID}/${encodeURIComponent(table)}${qs}`);
    const json = JSON.parse(res.body);
    if (json.error) throw new Error(`Airtable error: ${json.error.message || JSON.stringify(json.error)}`);
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
    if (json.error) throw new Error(`Airtable create error: ${json.error.message || JSON.stringify(json.error)}`);
  }
}

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };

  if (!BASE_ID || !API_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Airtable não configurado (AIRTABLE_BASE_ID ou AIRTABLE_API_KEY ausentes)" }) };
  }

  try {
    // ── GET: carrega carteira e watchlist ──────────────────────
    if (event.httpMethod === "GET") {
      const [pRecs, wRecs] = await Promise.all([
        listRecords("Portfolio"),
        listRecords("Watchlist"),
      ]);

      const portfolio = pRecs.map(r => ({
        id:       r.fields.entryId || r.id,
        ticker:   r.fields.ticker,
        avgPrice: r.fields.avgPrice,
        qty:      r.fields.qty ?? null,
      })).filter(p => p.ticker);

      const watchlist = wRecs.map(r => ({
        id:     r.fields.entryId || r.id,
        ticker: r.fields.ticker,
      })).filter(w => w.ticker);

      return { statusCode: 200, headers, body: JSON.stringify({ portfolio, watchlist }) };
    }

    // ── POST: salva carteira e watchlist (full replace) ────────
    if (event.httpMethod === "POST") {
      const { portfolio = [], watchlist = [] } = JSON.parse(event.body || "{}");

      // Busca IDs existentes para deletar
      const [pRecs, wRecs] = await Promise.all([
        listRecords("Portfolio"),
        listRecords("Watchlist"),
      ]);

      // Deleta tudo e re-insere
      await Promise.all([
        pRecs.length ? deleteRecords("Portfolio", pRecs.map(r => r.id)) : Promise.resolve(),
        wRecs.length ? deleteRecords("Watchlist", wRecs.map(r => r.id)) : Promise.resolve(),
      ]);

      await Promise.all([
        portfolio.length ? createRecords("Portfolio", portfolio.map(p => ({
          entryId:  p.id,
          ticker:   p.ticker,
          avgPrice: p.avgPrice,
          ...(p.qty != null ? { qty: p.qty } : {}),
        }))) : Promise.resolve(),
        watchlist.length ? createRecords("Watchlist", watchlist.map(w => ({
          entryId: w.id,
          ticker:  w.ticker,
        }))) : Promise.resolve(),
      ]);

      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };

  } catch (e) {
    console.error("portfolio-data error:", e.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
