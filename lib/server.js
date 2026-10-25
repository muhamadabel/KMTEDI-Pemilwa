const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const EMAIL_DOMAIN = 'mail.ugm.ac.id';
const EMAIL_PREFIX_RE = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const NIM_RE = /^[0-9A-Z/.-]{4,32}$/;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

let cachedDb = null;
function serviceDb() {
  if (!cachedDb) {
    cachedDb = createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'), {
      auth: { persistSession: false, autoRefreshToken: false }
    });
  }
  return cachedDb;
}

function clientIp(req) {
  const real = req.headers['x-real-ip'];
  if (typeof real === 'string' && real) return real.trim();
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

function hashKey(value) {
  return crypto.createHmac('sha256', requireEnv('ADMIN_SESSION_SECRET')).update(String(value)).digest('hex').slice(0, 32);
}

async function rateLimit(db, scope, identity, limit, windowSeconds) {
  const { data, error } = await db.rpc('api_rate_hit', {
    p_key: `${scope}:${hashKey(identity)}`,
    p_limit: limit,
    p_window_seconds: windowSeconds
  });
  if (error) throw error;
  if (!data) throw new HttpError(429, 'Terlalu banyak permintaan. Coba lagi beberapa menit lagi.');
}

// Only accept same-origin JSON POSTs. No CORS headers are sent, so other
// origins cannot read responses; the Origin check also blocks blind posts.
function guardRequest(req) {
  if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  const origin = req.headers.origin;
  if (origin) {
    const allowed = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    let host;
    try { host = new URL(origin).host; } catch { host = null; }
    if (host !== req.headers.host && !allowed.includes(origin)) {
      throw new HttpError(403, 'Origin tidak diizinkan.');
    }
  }
  const type = String(req.headers['content-type'] || '');
  if (!type.startsWith('application/json')) throw new HttpError(415, 'Content-Type harus application/json.');
  if (!req.body || typeof req.body !== 'object') throw new HttpError(400, 'Body tidak valid.');
  return req.body;
}

function str(value, max = 200) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, max);
}

function normalizeNim(value) {
  const nim = str(value, 64).replace(/\s+/g, '').toUpperCase();
  if (!NIM_RE.test(nim)) throw new HttpError(400, 'Format NIM tidak valid.');
  return nim;
}

function normalizeEmail(prefixOrEmail) {
  const raw = str(prefixOrEmail, 120).toLowerCase();
  const prefix = raw.endsWith(`@${EMAIL_DOMAIN}`) ? raw.slice(0, -EMAIL_DOMAIN.length - 1) : raw;
  if (!EMAIL_PREFIX_RE.test(prefix)) throw new HttpError(400, 'Username email UGM tidak valid.');
  return `${prefix}@${EMAIL_DOMAIN}`;
}

// Errors raised on purpose in SQL use SQLSTATE P0001 and carry a safe,
// user-facing message. Everything else is logged and hidden.
function dbFailure(error) {
  if (error && error.code === 'P0001') return new HttpError(400, error.message);
  console.error('Database error:', error);
  return new HttpError(500, 'Terjadi gangguan pada server. Coba lagi.');
}

function handler(fn) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      const body = guardRequest(req);
      const result = await fn(body, req);
      res.status(200).json({ success: true, ...result });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500 && !(err instanceof HttpError)) console.error(err);
      if (status === 405) res.setHeader('Allow', 'POST');
      res.status(status).json({
        success: false,
        error: err instanceof HttpError ? err.message : 'Terjadi gangguan pada server. Coba lagi.'
      });
    }
  };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

// --- Admin session tokens (HMAC-signed, short-lived) ----------------------
const SESSION_TTL_SECONDS = 2 * 60 * 60;

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function signSession(credentialsVersion) {
  const payload = b64url(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
    v: credentialsVersion,
    n: crypto.randomBytes(8).toString('hex')
  }));
  const sig = b64url(crypto.createHmac('sha256', requireEnv('ADMIN_SESSION_SECRET')).update(payload).digest());
  return `${payload}.${sig}`;
}

async function verifySession(db, token) {
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig) throw new HttpError(401, 'Sesi admin tidak valid. Silakan login ulang.');
  const expected = crypto.createHmac('sha256', requireEnv('ADMIN_SESSION_SECRET')).update(payload).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    throw new HttpError(401, 'Sesi admin tidak valid. Silakan login ulang.');
  }
  let data;
  try { data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { data = null; }
  if (!data || typeof data.exp !== 'number' || data.exp < Date.now() / 1000) {
    throw new HttpError(401, 'Sesi admin berakhir. Silakan login ulang.');
  }
  // Changing the PIN invalidates every session issued before the change.
  const { data: version, error } = await db.rpc('admin_credentials_version');
  if (error) throw dbFailure(error);
  if (!version || version !== data.v) throw new HttpError(401, 'Sesi admin berakhir. Silakan login ulang.');
}

module.exports = {
  HttpError,
  requireEnv,
  serviceDb,
  clientIp,
  rateLimit,
  str,
  normalizeNim,
  normalizeEmail,
  dbFailure,
  handler,
  escapeHtml,
  signSession,
  verifySession
};
