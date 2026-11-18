'use strict';

/**
 * Bank of Taiwan (臺灣銀行) posted FX rates, TWD per 1 unit of foreign currency.
 * Primary: official CSV https://rate.bot.com.tw/xrt/flcsv/0/YYYY-MM-DD
 * Fallback: public mirror of BoT quotes (haotool/app data branch on jsDelivr / GitHub raw),
 * used only when rate.bot.com.tw answers with its bot-challenge page.
 */

const CACHE = new Map(); // date -> { table, rateDate, source, fetchedAt }
const TODAY_TTL_MS = 15 * 60 * 1000;
const MAX_LOOKBACK_DAYS = 10;
let botBlockedUntil = 0;

function todayTaipei() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function shiftYmd(ymd, days) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function num(v) {
  const n = parseFloat(String(v == null ? '' : v).trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Official CSV rows look like:
 * USD,本行買入,32.45,32.8,...,本行賣出,33.12,32.9,...
 * (currency, "buy" label, cash buy, spot buy, forwards..., "sell" label, cash sell, spot sell, forwards...)
 */
function parseBotCsv(text) {
  const table = {};
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/);
  for (const line of lines) {
    const cells = line.split(',').map((c) => c.trim());
    const cur = cells[0];
    if (!/^[A-Z]{3}$/.test(cur)) continue;
    const sellIdx = cells.findIndex((c, i) => i > 0 && /賣出|Selling/i.test(c));
    const buyIdx = cells.findIndex((c, i) => i > 0 && /買入|Buying/i.test(c));
    if (sellIdx < 0) continue;
    table[cur] = {
      cashBuy: buyIdx >= 0 ? num(cells[buyIdx + 1]) : null,
      spotBuy: buyIdx >= 0 ? num(cells[buyIdx + 2]) : null,
      cashSell: num(cells[sellIdx + 1]),
      spotSell: num(cells[sellIdx + 2]),
    };
  }
  return table;
}

class BlockedError extends Error {}

async function fetchText(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 12000);
  try {
    const r = await fetch(url, {
      signal: ctl.signal,
      headers: { 'User-Agent': 'splitbill/1.0 (+https://splitbill-6ipe.onrender.com)', Accept: 'text/csv,application/json,*/*' },
    });
    const text = await r.text();
    return { status: r.status, type: r.headers.get('content-type') || '', text };
  } finally {
    clearTimeout(timer);
  }
}

/** Returns table (possibly empty = no quotes that day). Throws BlockedError on challenge page. */
async function fetchOfficial(date) {
  const res = await fetchText(`https://rate.bot.com.tw/xrt/flcsv/0/${date}`);
  if (res.status !== 200) throw new BlockedError('http ' + res.status);
  if (/^\s*</.test(res.text) || /Challenge Validation/i.test(res.text)) throw new BlockedError('challenge');
  return parseBotCsv(res.text);
}

function tableFromMirror(j) {
  const table = {};
  const details = (j && j.details) || {};
  for (const [cur, d] of Object.entries(details)) {
    table[cur] = {
      cashBuy: num(d?.cash?.buy), cashSell: num(d?.cash?.sell),
      spotBuy: num(d?.spot?.buy), spotSell: num(d?.spot?.sell),
    };
  }
  return table;
}

async function fetchMirror(date, isToday) {
  const paths = isToday
    ? ['public/rates/latest.json']
    : [`public/rates/history/${date}.json`];
  for (const p of paths) {
    for (const base of ['https://cdn.jsdelivr.net/gh/haotool/app@data/', 'https://raw.githubusercontent.com/haotool/app/data/']) {
      try {
        const res = await fetchText(base + p);
        if (res.status === 404) return null; // no data that day
        if (res.status !== 200) continue;
        const j = JSON.parse(res.text);
        const table = tableFromMirror(j);
        if (!Object.keys(table).length) return null;
        return { table, publishedAt: j.sourcePublishedAt || j.timestamp || null };
      } catch (_) { /* try next base */ }
    }
  }
  throw new Error('mirror_unavailable');
}

/** Load the BoT table for exactly `date` (null if BoT posted no quotes that day). */
async function loadDay(date, isToday) {
  const hit = CACHE.get(date);
  if (hit && (!isToday || Date.now() - hit.fetchedAt < TODAY_TTL_MS)) return hit;
  let entry = null;
  if (Date.now() > botBlockedUntil) {
    try {
      const table = await fetchOfficial(date);
      entry = { table: Object.keys(table).length ? table : null, source: 'bot', fetchedAt: Date.now() };
    } catch (e) {
      botBlockedUntil = Date.now() + 10 * 60 * 1000;
    }
  }
  if (!entry) {
    const m = await fetchMirror(date, isToday);
    entry = { table: m ? m.table : null, source: 'bot-mirror', publishedAt: m?.publishedAt || null, fetchedAt: Date.now() };
  }
  CACHE.set(date, entry);
  return entry;
}

/**
 * Rate for `currency` on `date` (YYYY-MM-DD, Taipei). Weekend/holiday → latest prior business day.
 * Future date → today's rate, provisional.
 */
async function getRate(currency, date, kind = 'cashSell') {
  const cur = String(currency || 'JPY').toUpperCase();
  const today = todayTaipei();
  if (cur === 'TWD') return { currency: cur, rate: 1, requestedDate: date || today, rateDate: date || today, provisional: false, source: 'identity' };
  let want = /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? date : today;
  let provisional = false;
  if (want > today) { want = today; provisional = true; }
  let d = want;
  for (let i = 0; i <= MAX_LOOKBACK_DAYS; i++, d = shiftYmd(d, -1)) {
    const entry = await loadDay(d, d === today);
    const q = entry.table && entry.table[cur];
    if (!entry.table) continue; // no quotes that day
    if (!q) break; // currency not listed by BoT
    let rate = q[kind];
    let usedKind = kind;
    if (!rate && kind === 'cashSell' && q.spotSell) { rate = q.spotSell; usedKind = 'spotSell'; }
    if (!rate) break;
    return {
      currency: cur, rate, kind: usedKind,
      requestedDate: date || today, rateDate: d, provisional,
      source: entry.source, publishedAt: entry.publishedAt || null,
      quote: q,
    };
  }
  const err = new Error('rate_not_found');
  err.code = 'rate_not_found';
  throw err;
}

module.exports = { getRate, parseBotCsv, todayTaipei };
