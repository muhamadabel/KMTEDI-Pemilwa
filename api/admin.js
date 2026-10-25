const {
  serviceDb, clientIp, rateLimit, str, dbFailure, handler, HttpError, signSession, verifySession
} = require('../lib/server');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function bearer(req) {
  const auth = String(req.headers.authorization || '');
  return auth.startsWith('Bearer ') ? auth.slice(7) : '';
}

function lines(value, maxItems = 20, maxLen = 400) {
  if (!Array.isArray(value)) return [];
  return value.filter(v => typeof v === 'string').map(v => v.trim().slice(0, maxLen)).filter(Boolean).slice(0, maxItems);
}

function isoOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new HttpError(400, 'Format tanggal tidak valid.');
  return d.toISOString();
}

async function call(db, fn, args) {
  const { data, error } = await db.rpc(fn, args);
  if (error) throw dbFailure(error);
  return data;
}

const actions = {
  async dashboard(db) {
    return { dashboard: await call(db, 'admin_dashboard') };
  },

  async toggle(db, body) {
    const field = str(body.field, 40);
    if (!['voting_open', 'results_published'].includes(field)) throw new HttpError(400, 'Field tidak dikenal.');
    return { result: await call(db, 'admin_toggle', { p_field: field }) };
  },

  async schedule(db, body) {
    await call(db, 'admin_set_schedule', { p_start: isoOrNull(body.start), p_end: isoOrNull(body.end) });
    return {};
  },

  async save_candidate(db, body) {
    const c = body.candidate || {};
    const id = c.id ? str(c.id, 64) : null;
    if (id && !UUID_RE.test(id)) throw new HttpError(400, 'ID calon tidak valid.');
    const result = await call(db, 'admin_save_candidate', {
      p_id: id,
      p_order_number: Number.parseInt(c.order_number, 10),
      p_name: str(c.name, 120),
      p_batch: str(c.batch, 20) || null,
      p_nim: str(c.nim, 40) || null,
      p_photo_url: typeof c.photo_url === 'string' ? c.photo_url.trim().slice(0, 1500000) : null,
      p_vision: str(c.vision, 2000),
      p_mission: lines(c.mission),
      p_programs: lines(c.programs),
      p_organization_history: str(c.organization_history, 2000),
      p_is_active: c.is_active !== false
    });
    return { result };
  },

  async delete_candidate(db, body) {
    const id = str(body.id, 64);
    if (!UUID_RE.test(id)) throw new HttpError(400, 'ID calon tidak valid.');
    await call(db, 'admin_delete_candidate', { p_id: id });
    return {};
  },

  async save_panels(db, body) {
    const slides = Array.isArray(body.hero_slides) ? body.hero_slides.slice(0, 6).map(s => ({
      image: typeof s?.image === 'string' ? s.image.trim().slice(0, 1500000) : '',
      caption: str(s?.caption, 200)
    })) : null;
    const timeline = Array.isArray(body.timeline_items) ? body.timeline_items.slice(0, 8).map((t, i) => ({
      no: String(i + 1).padStart(2, '0'),
      title: str(t?.title, 80),
      desc: str(t?.desc, 400),
      date: str(t?.date, 40)
    })) : null;
    await call(db, 'admin_save_panels', {
      p_hero_slides: slides,
      p_marquee_text: str(body.marquee_text, 400),
      p_about_statement: str(body.about_statement, 600),
      p_about_info: str(body.about_info, 1200),
      p_timeline_items: timeline
    });
    return {};
  },

  async reset(db, body) {
    if (body.confirm !== 'RESET') throw new HttpError(400, 'Konfirmasi reset tidak sesuai.');
    await call(db, 'admin_reset_all');
    return {};
  }
};

module.exports = handler(async (body, req) => {
  const db = serviceDb();
  const action = str(body.action, 40);

  if (action === 'login') {
    const ip = clientIp(req);
    await rateLimit(db, 'admin-login-ip', ip, 5, 15 * 60);
    await rateLimit(db, 'admin-login-all', 'global', 60, 60 * 60);
    const ok = await call(db, 'admin_check_pin', { p_pin: str(body.pin, 200) });
    if (!ok) throw new HttpError(401, 'PIN admin salah.');
    const version = await call(db, 'admin_credentials_version');
    return { token: signSession(version) };
  }

  const fn = Object.prototype.hasOwnProperty.call(actions, action) ? actions[action] : null;
  if (!fn) throw new HttpError(400, 'Aksi tidak dikenal.');

  await verifySession(db, bearer(req));
  return fn(db, body);
});
