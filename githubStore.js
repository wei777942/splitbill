'use strict';

/**
 * Durable trip + receipt photo store via GitHub Contents API.
 * Env: GITHUB_TOKEN, GITHUB_DATA_REPO (owner/name), optional GITHUB_DATA_BRANCH (default main).
 */

const crypto = require('crypto');

const API = 'https://api.github.com';

function repo() { return process.env.GITHUB_DATA_REPO || ''; }
function token() { return process.env.GITHUB_TOKEN || ''; }
function branch() { return process.env.GITHUB_DATA_BRANCH || 'main'; }

function enabled() {
  const REPO = repo();
  return Boolean(REPO && token() && REPO.includes('/'));
}

async function gh(pathname, opts = {}) {
  const REPO = repo();
  const TOKEN = token();
  const url = `${API}/repos/${REPO}${pathname}`;
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${TOKEN}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'splitbill-pwa',
    ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    ...(opts.headers || {}),
  };
  const res = await fetch(url, { ...opts, headers });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) { json = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`github ${res.status} ${pathname}: ${(json && json.message) || text.slice(0, 200)}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

async function getFile(path) {
  try {
    const j = await gh(`/contents/${encodeURI(path)}?ref=${encodeURIComponent(branch())}`);
    if (!j || !j.content) return null;
    const buf = Buffer.from(String(j.content).replace(/\n/g, ''), 'base64');
    return { buf, sha: j.sha, path: j.path };
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

/** Serialize Contents API writes — concurrent commits on one branch 409. */
let writeChain = Promise.resolve();
function enqueueWrite(fn) {
  const next = writeChain.then(fn, fn);
  writeChain = next.catch(() => {});
  return next;
}

async function putFile(path, buf, message, sha) {
  return enqueueWrite(async () => {
    const content = Buffer.from(buf).toString('base64');
    let attemptSha = sha;
    for (let attempt = 0; attempt < 4; attempt++) {
      const body = {
        message: message || `update ${path}`,
        content,
        branch: branch(),
      };
      if (attemptSha) body.sha = attemptSha;
      try {
        return await gh(`/contents/${encodeURI(path)}`, { method: 'PUT', body: JSON.stringify(body) });
      } catch (e) {
        if (e.status !== 409 && e.status !== 422) throw e;
        const cur = await getFile(path);
        if (!cur) {
          attemptSha = undefined;
          await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
          continue;
        }
        if (Buffer.compare(cur.buf, Buffer.from(buf)) === 0) {
          return { content: { sha: cur.sha, path } };
        }
        attemptSha = cur.sha;
        await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
      }
    }
    throw new Error(`github put exhausted retries for ${path}`);
  });
}

async function deleteFile(path, sha, message) {
  return enqueueWrite(async () => {
    let delSha = sha;
    if (!delSha) {
      const cur = await getFile(path);
      if (!cur) return;
      delSha = cur.sha;
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await gh(`/contents/${encodeURI(path)}`, {
          method: 'DELETE',
          body: JSON.stringify({ message: message || `delete ${path}`, sha: delSha, branch: branch() }),
        });
      } catch (e) {
        if (e.status === 404) return;
        if (e.status !== 409 && e.status !== 422) throw e;
        const cur = await getFile(path);
        if (!cur) return;
        delSha = cur.sha;
      }
    }
  });
}

async function listDir(path) {
  try {
    const j = await gh(`/contents/${encodeURI(path)}?ref=${encodeURIComponent(branch())}`);
    if (!Array.isArray(j)) return [];
    return j;
  } catch (e) {
    if (e.status === 404) return [];
    throw e;
  }
}

async function loadAllTrips() {
  const files = await listDir('trips');
  const out = new Map();
  for (const f of files) {
    if (f.type !== 'file' || !f.name.endsWith('.json')) continue;
    const code = f.name.replace(/\.json$/i, '').toUpperCase();
    const file = await getFile(f.path);
    if (!file) continue;
    try {
      const row = JSON.parse(file.buf.toString('utf8'));
      if (row && row.data) out.set(code, { data: row.data, updatedAt: Number(row.updatedAt) || Date.now(), _sha: file.sha });
    } catch (_) { /* skip bad */ }
  }
  return out;
}

async function saveTrip(code, row) {
  const c = String(code).toUpperCase();
  const path = `trips/${c}.json`;
  const payload = Buffer.from(JSON.stringify({ data: row.data, updatedAt: row.updatedAt }), 'utf8');
  let sha = row._sha;
  if (!sha) {
    const cur = await getFile(path);
    if (cur) sha = cur.sha;
  }
  try {
    const res = await putFile(path, payload, `trip ${c}`, sha);
    row._sha = res.content && res.content.sha;
  } catch (e) {
    // conflict: refetch and retry once if our updatedAt is newer
    if (e.status === 409 || e.status === 422) {
      const cur = await getFile(path);
      if (cur) {
        try {
          const prev = JSON.parse(cur.buf.toString('utf8'));
          if (Number(prev.updatedAt) > Number(row.updatedAt)) return; // lose LWW
        } catch (_) {}
        const res = await putFile(path, payload, `trip ${c} retry`, cur.sha);
        row._sha = res.content && res.content.sha;
        return;
      }
    }
    throw e;
  }
}

function photoPath(code, photoId) {
  return `photos/${String(code).toUpperCase()}/${photoId}.bin`;
}

function photoMetaPath(code, photoId) {
  return `photos/${String(code).toUpperCase()}/${photoId}.json`;
}

async function savePhoto(code, photoId, mime, buf) {
  const binPath = photoPath(code, photoId);
  const metaPath = photoMetaPath(code, photoId);
  await putFile(binPath, buf, `photo ${photoId}`);
  await putFile(
    metaPath,
    Buffer.from(JSON.stringify({ id: photoId, mime, sizeBytes: buf.length, trip: String(code).toUpperCase() }), 'utf8'),
    `photo meta ${photoId}`
  );
}

async function getPhoto(code, photoId) {
  const metaFile = await getFile(photoMetaPath(code, photoId));
  const binFile = await getFile(photoPath(code, photoId));
  if (!binFile) return null;
  let mime = 'image/jpeg';
  if (metaFile) {
    try { mime = JSON.parse(metaFile.buf.toString('utf8')).mime || mime; } catch (_) {}
  }
  return { mime, bytes: binFile.buf };
}

async function deletePhoto(code, photoId) {
  for (const p of [photoPath(code, photoId), photoMetaPath(code, photoId)]) {
    try { await deleteFile(p, null, `delete photo ${photoId}`); } catch (_) {}
  }
}

module.exports = {
  enabled,
  loadAllTrips,
  saveTrip,
  savePhoto,
  getPhoto,
  deletePhoto,
  uid: () => crypto.randomBytes(8).toString('hex'),
};
