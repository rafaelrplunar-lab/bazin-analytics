// quote.js — Yahoo Finance com autenticação cookie + crumb
const https = require("https");
const http  = require("http");

function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, { headers }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () =>
        resolve({ status: res.statusCode, headers: res.headers, body })
      );
    });
    req.on("error", reject);
    req.setTimeout(9000, () => { req.destroy(); reject(new Error("timeout")); });
  });
}

function parseCookies(setCookieArr = []) {
  const arr = Array.isArray(setCookieArr) ? setCookieArr : [setCookieArr];
  return arr.map((c) => c.split(";")[0]).filter(Boolean).join("; ");
}

let _session = null;
let _sessionTs = 0;

async function getSession() {
  if (_session && Date.now() - _sessionTs < 10 * 60 * 1000) return _session;

  const UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

  const consent = await httpsGet("https://fc.yahoo.com", {
    "User-Agent": UA,
    Accept: "text/html,application/xhtml+xml",
  });

  const rawCookies = consent.headers["set-cookie"] || [];
  const cookieStr  = parseCookies(rawCookies);

  const crumbRes = await httpsGet(
    "https://query2.finance.yahoo.com/v1/test/getcrumb",
    { "User-Agent": UA, Cookie: cookieStr, Accept: "*/*" }
  );

  let crumb = crumbRes.body.trim();
  if (!crumb || crumb.includes("<") || crumb.length > 20) {
    const alt = await httpsGet(
      "https://query1.finance.yahoo.com/v1/test/getcrumb",
      { "User-Agent": UA, Cookie: cookieStr }
    );
    crumb = alt.body.trim();
  }

  _session  = { cookies: cookieStr, crumb, ua: UA };
  _sessionTs = Date.now();
  console.log("Session OK, crumb:", crumb.slice(0, 8) + "...");
  return _session;
}

async function fetchQuoteSummary(ticker, session) {
  const modules = "price,summaryDetail,defaultKeyStatistics,financialData,assetProfile";
  const url =
    `https://query1.finance.yahoo.com/v11/finance/quoteSummary/${ticker}` +
    `?modules=${modules}&crumb=${encodeURIComponent(session.crumb)}`;

  const res = await httpsGet(url, {
    "User-Agent": session.ua,
    Cookie: session.cookies,
    Accept: "application/json",
  });

  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  const json = JSON.parse(res.body);
  if (json.quoteSummary?.error) throw new Error(json.quoteSummary.error.description || "API error");
  return json.quoteSummary?.result?.[0] || null;
}

async function fetchDividends(ticker, session) {
  const period1 = Math.floor((Date.now() - 5 * 365 * 86400000) / 1000);
  const period2 = Math.floor(Date.now() / 1000);
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}` +
    `?period1=${period1}&period2=${period2}&interval=3mo&events=div` +
    `&crumb=${encodeURIComponent(session.crumb)}`;

  const res = await httpsGet(url, {
    "User-Agent": session.ua,
    Cookie: session.cookies,
    Accept: "application/json",
  });

  if (res.status !== 200) return [];
  const json   = JSON.parse(res.body);
  const events = json?.chart?.result?.[0]?.events?.dividends || {};
  return Object.values(events).map((d) => ({
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
  if (!tickerParam) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Parâmetro 'ticker' obrigatório" }) };
  }

  const tickers = tickerParam
    .split(",")
    .map((t) => t.trim().toUpperCase().replace(".SA", ""))
    .filter(Boolean)
    .map((t) => `${t}.SA`);

  let session;
  try {
    session = await getSession();
  } catch (e) {
    console.error("Session error:", e.message);
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({ error: "Falha ao autenticar com Yahoo Finance", detail: e.message }),
    };
  }

  const results = {};

  await Promise.allSettled(
    tickers.map(async (sym) => {
      try {
        const [sumRes, divRes] = await Promise.allSettled([
          fetchQuoteSummary(sym, session),
          fetchDividends(sym, session),
        ]);

        if (sumRes.status === "rejected" || !sumRes.value) {
          console.error(`${sym} failed:`, sumRes.reason?.message);
          return;
        }

        const s  = sumRes.value;
        const pr = s.price                || {};
        const sd = s.summaryDetail        || {};
        const ks = s.defaultKeyStatistics || {};
        const fd = s.financialData        || {};
        const ap = s.assetProfile         || {};

        const raw = (v) =>
          v !== null && typeof v === "object" ? (v.raw ?? v.fmt ?? null) : v ?? null;

        results[sym.replace(".SA", "")] = {
          symbol:             sym.replace(".SA", ""),
          shortName:          pr.shortName  || pr.longName || sym,
          longName:           pr.longName   || "",
          sector:             ap.sector     || "",
          industry:           ap.industry   || "",
          regularMarketPrice: raw(pr.regularMarketPrice)  ?? 0,
          fiftyTwoWeekHigh:   raw(sd.fiftyTwoWeekHigh)    ?? raw(pr.fiftyTwoWeekHigh)  ?? 0,
          fiftyTwoWeekLow:    raw(sd.fiftyTwoWeekLow)     ?? raw(pr.fiftyTwoWeekLow)   ?? 0,
          earningsPerShare:   raw(ks.trailingEps)         ?? 0,
          priceEarnings:      raw(sd.trailingPE)          ?? null,
          bookValue:          raw(ks.bookValue)           ?? 0,
          dividendYield:      raw(sd.dividendYield)       ?? 0,
          payoutRatio:        raw(sd.payoutRatio)         ?? null,
          totalDebt:          raw(fd.totalDebt)           ?? 0,
          totalCash:          raw(fd.totalCash)           ?? 0,
          ebitda:             raw(fd.ebitda)              ?? 0,
          returnOnEquity:     raw(fd.returnOnEquity)      ?? 0,
          dividendsHistory:   divRes.status === "fulfilled" ? divRes.value : [],
        };
      } catch (err) {
        console.error(`Error ${sym}:`, err.message);
      }
    })
  );

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ results }),
  };
};
