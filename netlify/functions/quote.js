const https = require("https");

function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      let body = "";
      res.on("data", c => body += c);
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error("timeout")); });
  });
}

function parseCookies(arr = []) {
  return (Array.isArray(arr) ? arr : [arr]).map(c => c.split(";")[0]).filter(Boolean).join("; ");
}

// ── Session cache ──────────────────────────────────────────
let _session = null, _sessionTs = 0;

async function getSession() {
  if (_session && Date.now() - _sessionTs < 8 * 60 * 1000) return _session;

  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

  // 1. Cookies
  const r1 = await httpsGet("https://fc.yahoo.com", {
    "User-Agent": UA, "Accept": "text/html"
  });
  let cookieStr = parseCookies(r1.headers["set-cookie"] || []);

  // 2. Crumb via API
  let crumb = "";
  for (const host of ["query2", "query1"]) {
    const r = await httpsGet(`https://${host}.finance.yahoo.com/v1/test/getcrumb`, {
      "User-Agent": UA, "Cookie": cookieStr, "Accept": "*/*"
    });
    if (r.status === 200 && r.body.length > 0 && r.body.length < 30 && !r.body.includes("<")) {
      crumb = r.body.trim(); break;
    }
  }

  // 3. Fallback: crumb from HTML
  if (!crumb) {
    const r = await httpsGet("https://finance.yahoo.com/quote/AAPL", {
      "User-Agent": UA, "Cookie": cookieStr, "Accept": "text/html"
    });
    const m = r.body.match(/"crumb":"([^"]{5,20})"/);
    if (m) crumb = m[1].replace(/\\u002F/g, "/");
    const nc = parseCookies(r.headers["set-cookie"] || []);
    if (nc) cookieStr = cookieStr + "; " + nc;
  }

  _session  = { cookies: cookieStr, crumb, ua: UA };
  _sessionTs = Date.now();
  console.log("Session OK — crumb:", crumb.slice(0, 8), "cookies len:", cookieStr.length);
  return _session;
}

// ── v10 quoteSummary (fundamentals) ───────────────────────
async function fetchSummary(ticker, session) {
  const mods = "price,summaryDetail,defaultKeyStatistics,financialData,assetProfile";
  const url  = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=${mods}&crumb=${encodeURIComponent(session.crumb)}`;
  const res  = await httpsGet(url, {
    "User-Agent": session.ua, "Cookie": session.cookies, "Accept": "application/json"
  });
  console.log(`v10 ${ticker}:`, res.status);
  if (res.status !== 200) throw new Error(`v10 HTTP ${res.status}: ${res.body.slice(0, 150)}`);
  const json = JSON.parse(res.body);
  if (json.quoteSummary?.error) throw new Error(json.quoteSummary.error.description);
  return json.quoteSummary?.result?.[0] || null;
}

// ── v8 chart (price + dividends) ──────────────────────────
async function fetchChart(ticker, session) {
  const p1  = Math.floor((Date.now() - 5 * 365 * 86400000) / 1000);
  const p2  = Math.floor(Date.now() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?period1=${p1}&period2=${p2}&interval=3mo&events=div&crumb=${encodeURIComponent(session.crumb)}`;
  const res = await httpsGet(url, {
    "User-Agent": session.ua, "Cookie": session.cookies, "Accept": "application/json"
  });
  console.log(`v8 chart ${ticker}:`, res.status);
  if (res.status !== 200) return { price: 0, high52w: 0, divs: [] };
  const json   = JSON.parse(res.body);
  const meta   = json?.chart?.result?.[0]?.meta   || {};
  const events = json?.chart?.result?.[0]?.events?.dividends || {};
  return {
    price:  meta.regularMarketPrice || 0,
    high52w: meta.fiftyTwoWeekHigh  || 0,
    low52w:  meta.fiftyTwoWeekLow   || 0,
    divs: Object.values(events).map(d => ({
      date:   new Date(d.date * 1000).toISOString(),
      amount: d.amount,
    })),
  };
}

// ── Main handler ──────────────────────────────────────────
exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };

  const tickerParam = event.queryStringParameters?.ticker;

  // Debug endpoint
  if (tickerParam === "debug") {
    try {
      const s = await getSession();
      // Test a real ticker with v10
      const test = await fetchSummary("PETR4.SA", s).catch(e => ({ error: e.message }));
      return { statusCode: 200, headers, body: JSON.stringify({
        crumb_ok: s.crumb.length > 0,
        crumb_preview: s.crumb.slice(0, 8),
        cookies_length: s.cookies.length,
        v10_test: test ? "OK — price: " + (test?.price?.regularMarketPrice?.raw || test?.price?.regularMarketPrice || "?") : "FAIL",
      })};
    } catch(e) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
    }
  }

  if (!tickerParam) return { statusCode: 400, headers, body: JSON.stringify({ error: "Use ?ticker=BBAS3 ou ?ticker=debug" }) };

  const tickers = tickerParam.split(",")
    .map(t => t.trim().toUpperCase().replace(".SA", ""))
    .filter(Boolean)
    .map(t => `${t}.SA`);

  let session;
  try {
    session = await getSession();
  } catch(e) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: "Auth failed", detail: e.message }) };
  }

  const results = {}, errors = {};

  await Promise.allSettled(tickers.map(async sym => {
    try {
      const [sumRes, chartRes] = await Promise.allSettled([
        fetchSummary(sym, session),
        fetchChart(sym, session),
      ]);

      const chart = chartRes.status === "fulfilled" ? chartRes.value : { price: 0, high52w: 0, divs: [] };

      if (sumRes.status === "rejected" || !sumRes.value) {
        // If summary fails, try to at least return chart data
        if (chart.price > 0) {
          errors[sym] = `Summary failed (${sumRes.reason?.message}), using chart data only`;
          results[sym.replace(".SA", "")] = {
            symbol: sym.replace(".SA", ""), shortName: sym.replace(".SA", ""),
            regularMarketPrice: chart.price, fiftyTwoWeekHigh: chart.high52w,
            dividendsHistory: chart.divs,
            earningsPerShare: 0, priceEarnings: null, bookValue: 0,
            sector: "", industry: "", payoutRatio: null,
            totalDebt: 0, totalCash: 0, ebitda: 0, returnOnEquity: 0,
          };
        } else {
          errors[sym] = sumRes.reason?.message || "no data";
        }
        return;
      }

      const s  = sumRes.value;
      const pr = s.price                || {};
      const sd = s.summaryDetail        || {};
      const ks = s.defaultKeyStatistics || {};
      const fd = s.financialData        || {};
      const ap = s.assetProfile         || {};
      const raw = v => v !== null && typeof v === "object" ? (v.raw ?? v.fmt ?? null) : (v ?? null);

      // Price comes from chart if summary doesn't have it
      const price = raw(pr.regularMarketPrice) || chart.price || 0;

      results[sym.replace(".SA", "")] = {
        symbol:             sym.replace(".SA", ""),
        shortName:          pr.shortName || pr.longName || sym.replace(".SA", ""),
        longName:           pr.longName  || "",
        sector:             ap.sector    || "",
        industry:           ap.industry  || "",
        regularMarketPrice: price,
        fiftyTwoWeekHigh:   raw(sd.fiftyTwoWeekHigh) ?? chart.high52w ?? 0,
        fiftyTwoWeekLow:    raw(sd.fiftyTwoWeekLow)  ?? chart.low52w  ?? 0,
        earningsPerShare:   raw(ks.trailingEps)       ?? 0,
        priceEarnings:      raw(sd.trailingPE)        ?? null,
        bookValue:          raw(ks.bookValue)         ?? 0,
        payoutRatio:        raw(sd.payoutRatio)       ?? null,
        totalDebt:          raw(fd.totalDebt)         ?? 0,
        totalCash:          raw(fd.totalCash)         ?? 0,
        ebitda:             raw(fd.ebitda)            ?? 0,
        returnOnEquity:     raw(fd.returnOnEquity)    ?? 0,
        dividendsHistory:   chart.divs,
        // Data com (ex-dividend date)
        exDividendDate:     raw(sd.exDividendDate)    ?? null,
        lastDividendDate:   raw(ks.lastDividendDate)  ?? null,
        lastDividendValue:  raw(ks.lastDividendValue) ?? null,
      };
    } catch(err) {
      console.error(`Error ${sym}:`, err.message);
      errors[sym] = err.message;
    }
  }));

  return { statusCode: 200, headers, body: JSON.stringify({ results, errors }) };
};
