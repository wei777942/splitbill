'use strict';

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const STORE = path.join(DATA_DIR, 'trips.json');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
  etag: true,
  index: false,
}));

/** @type {Map<string, {data: object, updatedAt: number}>} */
const trips = new Map();
/** @type {Map<string, Set<import('http').ServerResponse>>} */
const sseClients = new Map();

function loadStore() {
  try {
    if (!fs.existsSync(STORE)) return;
    const raw = JSON.parse(fs.readFileSync(STORE, 'utf8'));
    for (const [code, row] of Object.entries(raw || {})) {
      trips.set(code, row);
    }
    console.log(`loaded ${trips.size} trips from store`);
  } catch (e) {
    console.warn('store load failed', e.message);
  }
}

let persistTimer = null;
function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    const obj = {};
    for (const [k, v] of trips) obj[k] = v;
    const tmp = STORE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, STORE);
  }, 100);
}

loadStore();

function genCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  return code;
}

function getTrip(code) {
  const row = trips.get(String(code).toUpperCase());
  if (!row) return null;
  const data = JSON.parse(JSON.stringify(row.data));
  data.updatedAt = row.updatedAt;
  return data;
}

function saveTrip(code, data) {
  const c = String(code).toUpperCase();
  const updatedAt = Date.now();
  data.code = c;
  data.updatedAt = updatedAt;
  trips.set(c, { data: JSON.parse(JSON.stringify(data)), updatedAt });
  persist();
  broadcast(c, data);
  return data;
}

function broadcast(code, data) {
  const clients = sseClients.get(code);
  if (!clients || clients.size === 0) return;
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(payload); }
    catch (_) { clients.delete(res); }
  }
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, ts: Date.now(), trips: trips.size });
});

app.post('/api/trips', (req, res) => {
  let code = genCode();
  for (let i = 0; i < 20 && getTrip(code); i++) code = genCode();
  const body = req.body || {};
  const trip = {
    code,
    name: String(body.name || '新行程').slice(0, 80),
    homeCurrency: String(body.homeCurrency || 'TWD').toUpperCase().slice(0, 8),
    localCurrency: String(body.localCurrency || 'JPY').toUpperCase().slice(0, 8),
    rate: typeof body.rate === 'number' && body.rate > 0 ? body.rate : null,
    rateManual: !!body.rateManual,
    members: Array.isArray(body.members) ? body.members : [],
    expenses: Array.isArray(body.expenses) ? body.expenses : [],
    createdAt: Date.now(),
  };
  saveTrip(code, trip);
  res.status(201).json(trip);
});

app.get('/api/trips/:code', (req, res) => {
  const trip = getTrip(req.params.code);
  if (!trip) return res.status(404).json({ error: 'not_found' });
  res.json(trip);
});

app.put('/api/trips/:code', (req, res) => {
  const code = String(req.params.code).toUpperCase();
  const existing = getTrip(code);
  const incoming = req.body;
  if (!incoming || typeof incoming !== 'object') {
    return res.status(400).json({ error: 'invalid_body' });
  }
  const clientUpdated = Number(incoming.updatedAt) || 0;
  if (existing && clientUpdated > 0 && clientUpdated < existing.updatedAt - 2000) {
    return res.status(409).json({ error: 'stale', trip: existing });
  }
  const trip = {
    code,
    name: String(incoming.name || existing?.name || '新行程').slice(0, 80),
    homeCurrency: String(incoming.homeCurrency || existing?.homeCurrency || 'TWD').toUpperCase().slice(0, 8),
    localCurrency: String(incoming.localCurrency || existing?.localCurrency || 'JPY').toUpperCase().slice(0, 8),
    rate: typeof incoming.rate === 'number' ? incoming.rate : (existing?.rate ?? null),
    rateManual: incoming.rateManual != null ? !!incoming.rateManual : !!existing?.rateManual,
    members: Array.isArray(incoming.members) ? incoming.members : (existing?.members || []),
    expenses: Array.isArray(incoming.expenses) ? incoming.expenses : (existing?.expenses || []),
    createdAt: existing?.createdAt || Date.now(),
  };
  res.json(saveTrip(code, trip));
});

app.get('/api/trips/:code/events', (req, res) => {
  const code = String(req.params.code).toUpperCase();
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  if (!sseClients.has(code)) sseClients.set(code, new Set());
  sseClients.get(code).add(res);

  const trip = getTrip(code);
  res.write(`data: ${JSON.stringify(trip || { missing: true, code })}\n\n`);
  const ping = setInterval(() => {
    try { res.write(`: ping ${Date.now()}\n\n`); } catch (_) { clearInterval(ping); }
  }, 25000);

  req.on('close', () => {
    clearInterval(ping);
    const set = sseClients.get(code);
    if (set) {
      set.delete(res);
      if (set.size === 0) sseClients.delete(code);
    }
  });
});

app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api')) {
    return res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
  next();
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`splitbill listening on ${PORT}`);
});
