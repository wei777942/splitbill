'use strict';

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Pool } = require('pg');
const ghStore = require('./githubStore');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const STORE = path.join(DATA_DIR, 'trips.json');
const MIGRATE_EXPORT = path.join(DATA_DIR, 'migrate-export.json');

const MAX_PHOTO_BYTES = 350 * 1024; // allow a little headroom above client 300KB target
const MAX_PHOTOS_PER_EXPENSE = 3;

const app = express();
app.use(cors());
app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
  etag: true,
  index: false,
}));

/** @type {Map<string, {data: object, updatedAt: number}>} */
const trips = new Map();
/** @type {Map<string, Set<import('http').ServerResponse>>} */
const sseClients = new Map();

let pool = null;
let usingPg = false;
let usingGh = false;
const PHOTO_DIR = path.join(DATA_DIR, 'photos');
fs.mkdirSync(PHOTO_DIR, { recursive: true });

function storageName() {
  if (usingPg) return 'postgres';
  if (usingGh) return 'github';
  return 'json';
}

function localPhotoBin(code, photoId) {
  const dir = path.join(PHOTO_DIR, String(code).toUpperCase());
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${photoId}.bin`);
}

function localPhotoMeta(code, photoId) {
  const dir = path.join(PHOTO_DIR, String(code).toUpperCase());
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${photoId}.json`);
}

async function writePhoto(code, expenseId, photoId, mime, buf) {
  const c = String(code).toUpperCase();
  if (usingPg && pool) {
    await pool.query(
      `INSERT INTO expense_photos (id, trip_code, expense_id, mime, bytes, size_bytes, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [photoId, c, expenseId, mime, buf, buf.length, Date.now()]
    );
    return;
  }
  if (usingGh) {
    await ghStore.savePhoto(c, photoId, mime, buf);
    return;
  }
  fs.writeFileSync(localPhotoBin(c, photoId), buf);
  fs.writeFileSync(localPhotoMeta(c, photoId), JSON.stringify({ id: photoId, mime, expenseId, sizeBytes: buf.length }));
}

async function readPhoto(code, photoId) {
  const c = String(code).toUpperCase();
  if (usingPg && pool) {
    const { rows } = await pool.query(
      'SELECT mime, bytes FROM expense_photos WHERE id = $1 AND trip_code = $2',
      [photoId, c]
    );
    if (!rows.length) return null;
    return { mime: rows[0].mime || 'image/jpeg', bytes: rows[0].bytes };
  }
  if (usingGh) {
    return ghStore.getPhoto(c, photoId);
  }
  const bin = localPhotoBin(c, photoId);
  const metaP = localPhotoMeta(c, photoId);
  if (!fs.existsSync(bin)) return null;
  let mime = 'image/jpeg';
  try { mime = JSON.parse(fs.readFileSync(metaP, 'utf8')).mime || mime; } catch (_) {}
  return { mime, bytes: fs.readFileSync(bin) };
}

async function removePhoto(code, photoId) {
  const c = String(code).toUpperCase();
  if (usingPg && pool) {
    const del = await pool.query(
      'DELETE FROM expense_photos WHERE id = $1 AND trip_code = $2 RETURNING expense_id',
      [photoId, c]
    );
    return del.rows.length > 0;
  }
  if (usingGh) {
    await ghStore.deletePhoto(c, photoId);
    return true;
  }
  const bin = localPhotoBin(c, photoId);
  const metaP = localPhotoMeta(c, photoId);
  const ok = fs.existsSync(bin);
  try { fs.unlinkSync(bin); } catch (_) {}
  try { fs.unlinkSync(metaP); } catch (_) {}
  return ok;
}

function genCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  return code;
}

function uid() {
  return crypto.randomBytes(8).toString('hex');
}

function getTrip(code) {
  const row = trips.get(String(code).toUpperCase());
  if (!row) return null;
  const data = JSON.parse(JSON.stringify(row.data));
  data.updatedAt = row.updatedAt;
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

async function persistRow(code, row) {
  if (usingPg && pool) {
    await pool.query(
      `INSERT INTO trips (code, data, updated_at)
       VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (code) DO UPDATE
         SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at
       WHERE trips.updated_at <= EXCLUDED.updated_at`,
      [code, JSON.stringify(row.data), row.updatedAt]
    );
    return;
  }
  if (usingGh) {
    await ghStore.saveTrip(code, row);
    return;
  }
  // JSON fallback (also used as local cache alongside github boot)
  const obj = {};
  for (const [k, v] of trips) {
    const { _sha, ...rest } = v;
    obj[k] = rest;
  }
  const tmp = STORE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, STORE);
}

/** Respect client updatedAt for LWW. */
function saveTrip(code, data, clientUpdatedAt) {
  const c = String(code).toUpperCase();
  const updatedAt = Number(clientUpdatedAt) > 0 ? Number(clientUpdatedAt) : Date.now();
  data.code = c;
  data.updatedAt = updatedAt;
  // ensure expenses keep photoIds arrays
  if (Array.isArray(data.expenses)) {
    data.expenses = data.expenses.map((e) => ({
      ...e,
      photoIds: Array.isArray(e.photoIds) ? e.photoIds.slice(0, MAX_PHOTOS_PER_EXPENSE) : [],
    }));
  }
  const row = { data: JSON.parse(JSON.stringify(data)), updatedAt };
  trips.set(c, row);
  // fire-and-forget durable write; log errors
  Promise.resolve(persistRow(c, row)).catch((e) => console.error('persist failed', c, e.message));
  broadcast(c, data);
  return data;
}

function loadJsonFallback() {
  try {
    if (!fs.existsSync(STORE)) return;
    const raw = JSON.parse(fs.readFileSync(STORE, 'utf8'));
    for (const [code, row] of Object.entries(raw || {})) {
      trips.set(code, row);
    }
    console.log(`loaded ${trips.size} trips from JSON store`);
  } catch (e) {
    console.warn('JSON store load failed', e.message);
  }
}

async function initDb() {
  const url = process.env.DATABASE_URL;
  if (url) {
    pool = new Pool({
      connectionString: url,
      ssl: url.includes('localhost') || url.includes('127.0.0.1')
        ? false
        : { rejectUnauthorized: false },
      max: 3,
      idleTimeoutMillis: 30000,
    });
    await pool.query(`
      CREATE TABLE IF NOT EXISTS trips (
        code TEXT PRIMARY KEY,
        data JSONB NOT NULL,
        updated_at BIGINT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS expense_photos (
        id TEXT PRIMARY KEY,
        trip_code TEXT NOT NULL REFERENCES trips(code) ON DELETE CASCADE,
        expense_id TEXT NOT NULL,
        mime TEXT NOT NULL DEFAULT 'image/jpeg',
        bytes BYTEA NOT NULL,
        size_bytes INT NOT NULL,
        created_at BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_photos_expense
        ON expense_photos (trip_code, expense_id);
    `);
    usingPg = true;
    const { rows } = await pool.query('SELECT code, data, updated_at FROM trips');
    for (const r of rows) {
      const data = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
      trips.set(r.code, { data, updatedAt: Number(r.updated_at) });
    }
    console.log(`loaded ${trips.size} trips from Postgres`);
  } else if (ghStore.enabled()) {
    usingGh = true;
    const loaded = await ghStore.loadAllTrips();
    for (const [code, row] of loaded) trips.set(code, row);
    console.log(`loaded ${trips.size} trips from GitHub ${process.env.GITHUB_DATA_REPO}`);
  } else {
    console.warn('DATABASE_URL / GITHUB_TOKEN not set — using JSON + local photo files');
    loadJsonFallback();
  }

  // One-shot migrate from export + local JSON into active durable store
  const sources = [];
  for (const p of [MIGRATE_EXPORT, STORE]) {
    try {
      if (fs.existsSync(p)) sources.push(JSON.parse(fs.readFileSync(p, 'utf8')));
    } catch (_) {}
  }
  let migrated = 0;
  for (const srcMap of sources) {
    for (const [code, row] of Object.entries(srcMap || {})) {
      if (!row || !row.data) continue;
      const c = String(code).toUpperCase();
      const existing = trips.get(c);
      const incomingAt = Number(row.updatedAt) || 0;
      if (existing && existing.updatedAt >= incomingAt) continue;
      const data = JSON.parse(JSON.stringify(row.data));
      data.code = c;
      data.updatedAt = incomingAt || Date.now();
      const next = { data, updatedAt: data.updatedAt };
      trips.set(c, next);
      await persistRow(c, next);
      migrated += 1;
    }
  }
  if (migrated) console.log(`migrated ${migrated} trips into ${storageName()}`);
}

function parseDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const m = /^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/=]+)$/i.exec(dataUrl.trim());
  if (!m) return null;
  let mime = m[1].toLowerCase();
  if (mime === 'image/jpg') mime = 'image/jpeg';
  const buf = Buffer.from(m[2], 'base64');
  return { mime, buf };
}

app.get('/api/rate', async (req, res) => {
  const from = String(req.query.from || 'JPY').toUpperCase();
  const to = String(req.query.to || 'TWD').toUpperCase();
  if (from === to) return res.json({ rate: 1, source: 'identity' });
  const tryFetch = async (url, pick) => {
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error('http ' + r.status);
    const j = await r.json();
    const rate = pick(j);
    if (!(rate > 0)) throw new Error('no rate');
    return rate;
  };
  try {
    const rate = await tryFetch(
      `https://api.frankfurter.dev/v1/latest?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      (j) => j.rates && j.rates[to]
    );
    return res.json({ rate, source: 'frankfurter' });
  } catch (_) {}
  try {
    const rate = await tryFetch(
      `https://open.er-api.com/v6/latest/${encodeURIComponent(from)}`,
      (j) => j.rates && j.rates[to]
    );
    return res.json({ rate, source: 'open.er-api' });
  } catch (e) {
    return res.status(502).json({ error: 'rate_unavailable', message: String(e.message || e) });
  }
});

app.get('/api/health', async (_req, res) => {
  let photoCount = 0;
  let photoBytes = 0;
  if (usingPg && pool) {
    try {
      const r = await pool.query('SELECT COUNT(*)::int AS n, COALESCE(SUM(size_bytes),0)::bigint AS b FROM expense_photos');
      photoCount = r.rows[0].n;
      photoBytes = Number(r.rows[0].b);
    } catch (_) {}
  }
  res.json({
    ok: true,
    ts: Date.now(),
    trips: trips.size,
    storage: storageName(),
    photos: photoCount,
    photoBytes,
    photoLimits: {
      maxPerExpense: MAX_PHOTOS_PER_EXPENSE,
      maxBytesServer: MAX_PHOTO_BYTES,
      clientTargetBytes: 300 * 1024,
      clientMaxEdge: 1280,
      jpegQuality: 0.7,
    },
  });
});

app.post('/api/trips', (req, res) => {
  let code = genCode();
  for (let i = 0; i < 20 && getTrip(code); i++) code = genCode();
  const body = req.body || {};
  const now = Date.now();
  const trip = {
    code,
    name: String(body.name || '新行程').slice(0, 80),
    homeCurrency: String(body.homeCurrency || 'TWD').toUpperCase().slice(0, 8),
    localCurrency: String(body.localCurrency || 'JPY').toUpperCase().slice(0, 8),
    rate: typeof body.rate === 'number' && body.rate > 0 ? body.rate : null,
    rateManual: !!body.rateManual,
    members: Array.isArray(body.members) ? body.members : [],
    expenses: Array.isArray(body.expenses) ? body.expenses : [],
    createdAt: now,
  };
  saveTrip(code, trip, now);
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
  if (existing && clientUpdated > 0 && clientUpdated < existing.updatedAt) {
    return res.status(409).json({ error: 'stale', trip: existing });
  }
  // Preserve photoIds from existing expenses when client omits them
  const prevById = new Map((existing?.expenses || []).map((e) => [e.id, e]));
  const expenses = Array.isArray(incoming.expenses)
    ? incoming.expenses.map((e) => {
        const prev = prevById.get(e.id);
        const photoIds = Array.isArray(e.photoIds)
          ? e.photoIds
          : (prev && Array.isArray(prev.photoIds) ? prev.photoIds : []);
        return { ...e, photoIds: photoIds.slice(0, MAX_PHOTOS_PER_EXPENSE) };
      })
    : (existing?.expenses || []);

  // Delete orphaned photos when expenses removed
  if (usingPg && pool && existing) {
    const keepExp = new Set(expenses.map((e) => e.id));
    const removed = (existing.expenses || []).filter((e) => !keepExp.has(e.id)).map((e) => e.id);
    if (removed.length) {
      pool.query(
        'DELETE FROM expense_photos WHERE trip_code = $1 AND expense_id = ANY($2::text[])',
        [code, removed]
      ).catch((e) => console.error('photo cleanup', e.message));
    }
  }

  const trip = {
    code,
    name: String(incoming.name || existing?.name || '新行程').slice(0, 80),
    homeCurrency: String(incoming.homeCurrency || existing?.homeCurrency || 'TWD').toUpperCase().slice(0, 8),
    localCurrency: String(incoming.localCurrency || existing?.localCurrency || 'JPY').toUpperCase().slice(0, 8),
    rate: typeof incoming.rate === 'number' ? incoming.rate : (existing?.rate ?? null),
    rateManual: incoming.rateManual != null ? !!incoming.rateManual : !!existing?.rateManual,
    members: Array.isArray(incoming.members) ? incoming.members : (existing?.members || []),
    expenses,
    createdAt: existing?.createdAt || Date.now(),
  };
  const stamp = clientUpdated || Date.now();
  res.json(saveTrip(code, trip, stamp));
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

/** Upload a receipt photo (base64 data URL). Max 3 per expense. */
app.post('/api/trips/:code/expenses/:expenseId/photos', async (req, res) => {
  const code = String(req.params.code).toUpperCase();
  const expenseId = String(req.params.expenseId);
  const trip = getTrip(code);
  if (!trip) return res.status(404).json({ error: 'not_found' });
  const exp = (trip.expenses || []).find((e) => e.id === expenseId);
  if (!exp) return res.status(404).json({ error: 'expense_not_found' });
  const photoIds = Array.isArray(exp.photoIds) ? exp.photoIds : [];
  if (photoIds.length >= MAX_PHOTOS_PER_EXPENSE) {
    return res.status(400).json({ error: 'photo_limit', max: MAX_PHOTOS_PER_EXPENSE });
  }
  const parsed = parseDataUrl(req.body && req.body.dataUrl);
  if (!parsed) return res.status(400).json({ error: 'invalid_image' });
  if (parsed.buf.length > MAX_PHOTO_BYTES) {
    return res.status(413).json({ error: 'too_large', maxBytes: MAX_PHOTO_BYTES });
  }
  const id = uid();
  const now = Date.now();
  try {
    await writePhoto(code, expenseId, id, parsed.mime, parsed.buf);
  } catch (e) {
    console.error('photo insert', e.message);
    return res.status(500).json({ error: 'db_error' });
  }
  exp.photoIds = [...photoIds, id];
  const stamp = Math.max(Number(trip.updatedAt) || 0, now) + 1;
  saveTrip(code, trip, stamp);
  res.status(201).json({ id, mime: parsed.mime, sizeBytes: parsed.buf.length, expenseId });
});

app.get('/api/trips/:code/photos/:photoId', async (req, res) => {
  const code = String(req.params.code).toUpperCase();
  const photoId = String(req.params.photoId);
  try {
    const row = await readPhoto(code, photoId);
    if (!row) return res.status(404).json({ error: 'not_found' });
    res.setHeader('Content-Type', row.mime || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(row.bytes);
  } catch (e) {
    console.error('photo get', e.message);
    res.status(500).json({ error: 'db_error' });
  }
});

app.delete('/api/trips/:code/photos/:photoId', async (req, res) => {
  const code = String(req.params.code).toUpperCase();
  const photoId = String(req.params.photoId);
  const trip = getTrip(code);
  if (!trip) return res.status(404).json({ error: 'not_found' });
  try {
    const ok = await removePhoto(code, photoId);
    if (!ok && usingPg) return res.status(404).json({ error: 'not_found' });
  } catch (e) {
    console.error('photo delete', e.message);
    return res.status(500).json({ error: 'db_error' });
  }
  let changed = false;
  for (const e of trip.expenses || []) {
    if (Array.isArray(e.photoIds) && e.photoIds.includes(photoId)) {
      e.photoIds = e.photoIds.filter((x) => x !== photoId);
      changed = true;
    }
  }
  if (changed) {
    const stamp = Date.now();
    saveTrip(code, trip, stamp);
  }
  res.json({ ok: true, id: photoId });
});

app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api')) {
    return res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
  next();
});

initDb()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`splitbill listening on ${PORT} storage=${storageName()}`);
    });
  })
  .catch((e) => {
    console.error('DB init failed, falling back to JSON', e.message);
    loadJsonFallback();
    usingPg = false;
    pool = null;
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`splitbill listening on ${PORT} storage=json (fallback)`);
    });
  });
