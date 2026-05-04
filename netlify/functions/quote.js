const https = require("https");

function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error("timeout")); });
  });
}

function parseCookies(arr = []) {
  return (Array.isArray(arr) ? arr : [arr]).map(c => c.split(";")[0]).filter(Boolean).join("; ");
}

let _session = null;
let _sessionTs = 0;

async function getSession() {
  if (_session && Date.now() - _sessionTs < 8 * 60 * 1000) return _session;

  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

  // Step 1: Get cookies from Yahoo Finance consent page
  const r1 = await httpsGet("https://fc.yahoo.com", {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
  });
  console.log("fc.yahoo.com status:", r1.status);

  let cookieStr = parseCookies(r1.headers["set-cookie"] || []);
  console.log("Cookies length:", cookieStr.length);

  // Step 2: Get crumb — try both endpoints
  let crumb = "";
  for (const host of ["query2", "query1"]) {
    const r2 = await httpsGet(
      `https://${host}.finance.yahoo.com/v1/test/getcrumb`,
      { "User-Agent": UA, "Cookie": cookieStr, "Accept": "*/*" }
    );
    console.log(`${host} crumb status:`, r2.status, "body:", r2.body.slice(0, 40));
    if (r2.status === 200 && r2.body.length > 0 && r2.body.length < 30 && !r2.body.includes("<")) {
      crumb = r2.body.trim();
      break;
    }
  }

  if (!crumb) {
    // Step 3: fallback — get crumb from Yahoo Finance HTML page
    const r3 = await httpsGet("https://finance.yahoo.com/quote/AAPL", {
      "User-Agent": UA,
      "Cookie": cookieStr,
      "Accept": "text/html",
    });
    // Extract crumb from HTML
    const match = r3.body.match(/"crumb":"([^"]+)"/);
    if (match) crumb = match[1].replace(/\\u002F/g, "/");
    console.log("HTML crumb fallback:", crumb ? crumb.slice(0, 10) : "NOT FOUND");
    // Also grab any new cookies
    const newCookies = parseCookies(r3.headers["set-cookie"] || []);
    if (newCookies) cookieStr = cookieStr + "; " + newCookies;
  }

  console.log("Final crumb:", crumb ? crumb.slice(0, 10) + "..." : "EMPTY");
  _session  = { cookies: cookieStr, crumb, ua: UA };
  _sessionTs = Date.now();
  return _session;
}

async function fetchQuoteSummary(ticker, session) {
  const modules = "price,summaryDetail,defaultKeyStatistics,financialData,assetProfile";
  const url = `https://query1.finance.yahoo.com/v11/finance/quoteSummary/${ticker}?modules=${modules}&crumb=${encodeURIComponent(session.crumb)}`;

  const res = await httpsGet(url, {
    "User-Agent": session.ua,
    "Cookie": session.cookies,
    "Accept": "application/json",
  });

  console.log(`quoteSummary ${ticker} status:`, res.status);
  if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${res.body.slice(0, 200)}`);

  const json = JSON.parse(res.body);
  if (json.quoteSummary?.error) throw new Error(json.quoteSummary.error.description || "API error");
  return json.quoteSummary?.result?.[0] || null;
}

async function fetchDividends(ticker, session) {
  const period1 = Math.floor((Date.now() - 5 * 365 * 86400000) / 1000);
  const period2 = Math.floor(Date.now() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?period1=${period1}&period2=${period2}&interval=3mo&events=div&crumb=${encodeURIComponent(session.crumb)}`;

  const res = await httpsGet(url, {
    "User-Agent": session.ua,
    "Cookie": session.cookies,
    "Accept": "application/json",
  });

  console.log(`dividends ${ticker} status:`, res.status);
  if (res.status !== 200) return [];

  const json   = JSON.parse(res.body);
  const events = json?.chart?.result?.[0]?.events?.dividends || {};
  return Object.values(events).map(d => ({
    date:   new Date(d.date * 1000).toISOString(),
    amount: d.amount,
  }));
}

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };

  const tickerParam = event.queryStringParameters?.ticker;

  // ── DEBUG endpoint ──────────────────────────────────────
  if (tickerParam === "debug") {
    try {
      const session = await getSession();
      return {
        statusCode: 200, headers,
        body: JSON.stringify({
          crumb_length: session.crumb.length,
          crumb_preview: session.crumb.slice(0, 8),
          cookies_length: session.cookies.length,
          ok: session.crumb.length > 0,
        }),
      };
    } catch(e) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
    }
  }

  if (!tickerParam) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Parâmetro 'ticker' obrigatório. Use ?ticker=BBAS3 ou ?ticker=debug" }) };
  }

  const tickers = tickerParam.split(",")
    .map(t => t.trim().toUpperCase().replace(".SA", ""))
    .filter(Boolean)
    .map(t => `${t}.SA`);

  let session;
  try {
    session = await getSession();
  } catch(e) {
    console.error("Session error:", e.message);
    return { statusCode: 502, headers, body: JSON.stringify({ error: "Auth failed", detail: e.message }) };
  }

  const results = {};
  const errors  = {};

  await Promise.allSettled(tickers.map(async (sym) => {
    try {
      const [sumRes, divRes] = await Promise.allSettled([
        fetchQuoteSummary(sym, session),
        fetchDividends(sym, session),
      ]);

      if (sumRes.status === "rejected" || !sumRes.value) {
        errors[sym] = sumRes.reason?.message || "no data";
        return;
      }

      const s  = sumRes.value;
      const pr = s.price                || {};
      const sd = s.summaryDetail        || {};
      const ks = s.defaultKeyStatistics || {};
      const fd = s.financialData        || {};
      const ap = s.assetProfile         || {};
      const raw = v => (v !== null && typeof v === "object") ? (v.raw ?? v.fmt ?? null) : (v ?? null);

      results[sym.replace(".SA", "")] = {
        symbol:             sym.replace(".SA", ""),
        shortName:          pr.shortName  || pr.longName || sym,
        longName:           pr.longName   || "",
        sector:             ap.sector     || "",
        industry:           ap.industry   || "",
        regularMarketPrice: raw(pr.regularMarketPrice) ?? 0,
        fiftyTwoWeekHigh:   raw(sd.fiftyTwoWeekHigh)   ?? raw(pr.fiftyTwoWeekHigh) ?? 0,
        earningsPerShare:   raw(ks.trailingEps)        ?? 0,
        priceEarnings:      raw(sd.trailingPE)         ?? null,
        bookValue:          raw(ks.bookValue)          ?? 0,
        payoutRatio:        raw(sd.payoutRatio)        ?? null,
        totalDebt:          raw(fd.totalDebt)          ?? 0,
        totalCash:          raw(fd.totalCash)          ?? 0,
        ebitda:             raw(fd.ebitda)             ?? 0,
        returnOnEquity:     raw(fd.returnOnEquity)     ?? 0,
        dividendsHistory:   divRes.status === "fulfilled" ? divRes.value : [],
      };
    } catch(err) {
      console.error(`Error ${sym}:`, err.message);
      errors[sym] = err.message;
    }
  }));

  return {
    statusCode: 200, headers,
    body: JSON.stringify({ results, errors, tickers_requested: tickers }),
  };
};
