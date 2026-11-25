import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '../..');
const MIG_DIR = path.join(REPO_ROOT, 'supabase/migrations');

/**
 * Create an isolated in-memory PostgreSQL 16 (PGlite) test database
 * with Supabase-like roles (anon, authenticated, service_role), pgcrypto,
 * baseline migrations, our new migration, and seeded candidates.
 */
export async function createTestPg({ openVoting = true, reApplyLatest = false } = {}) {
  const pg = new PGlite({ extensions: { pgcrypto } });

  await pg.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    create schema extensions;
    create extension pgcrypto with schema extensions;
    create schema auth;
    create table auth.users (id uuid primary key default gen_random_uuid(), email text, raw_user_meta_data jsonb);
    create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
    create schema storage;
    create table storage.buckets (id text primary key, name text, public boolean);
    create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text);
    alter table storage.objects enable row level security;
    grant usage on schema public, extensions to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
    set search_path = public, extensions;
  `);

  const files = fs.readdirSync(MIG_DIR).filter(f => f.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(MIG_DIR, file), 'utf8');
    await pg.exec(sql);
  }

  await pg.exec(fs.readFileSync(path.join(REPO_ROOT, 'supabase/seed.sql'), 'utf8'));

  if (reApplyLatest) {
    const latest = files[files.length - 1];
    await pg.exec(fs.readFileSync(path.join(MIG_DIR, latest), 'utf8'));
  }

  // Ensure every seeded candidate has a tally row
  await pg.exec(`
    insert into public.vote_tallies (candidate_id, votes)
    select id, 0 from public.candidates
    on conflict (candidate_id) do nothing;
  `);

  if (openVoting) {
    await pg.exec(`update public.election_settings set voting_open = true, voting_start = null, voting_end = null where id = true;`);
  }

  return pg;
}

/**
 * Supabase-client-compatible RPC adapter backed by real PGlite PostgreSQL.
 * Serializes role switching safely so concurrent Promise.all callers in Node
 * execute cleanly against the single PGlite connection.
 */
export function createSupabaseRpcAdapter(pg, { role = 'service_role' } = {}) {
  let queue = Promise.resolve();

  function runExclusive(task) {
    const next = queue.then(task, task);
    queue = next.catch(() => {});
    return next;
  }

  return {
    async rpc(fnName, params = {}) {
      return runExclusive(async () => {
        if (!/^[a-z_][a-z0-9_]*$/i.test(fnName)) {
          return { data: null, error: { code: '42601', message: `Invalid RPC name: ${fnName}` } };
        }
        const entries = Object.entries(params || {});
        const argSql = entries.map(([k], idx) => `${k} => $${idx + 1}`).join(', ');
        const values = entries.map(([, v]) => v);
        const query = `select public.${fnName}(${argSql}) as result`;
        try {
          await pg.exec(`set local role ${role};`).catch(() => {});
          await pg.exec(`set role ${role};`);
          const res = await pg.query(query, values);
          await pg.exec('reset role;');
          const value = res.rows.length === 1 ? res.rows[0].result : res.rows;
          return { data: value, error: null };
        } catch (err) {
          await pg.exec('reset role;').catch(() => {});
          return {
            data: null,
            error: {
              code: err.code || 'XX000',
              message: err.message || String(err)
            }
          };
        }
      });
    },

    // Expose exclusive query helper for assertions/setup in tests
    query(sql, values) {
      return runExclusive(() => pg.query(sql, values));
    },

    exec(sql) {
      return runExclusive(() => pg.exec(sql));
    }
  };
}

/**
 * Invoke a Vercel CommonJS API handler (req, res) in memory.
 */
export async function invokeHandler(fn, { method = 'POST', body = {}, headers = {}, ip = '127.0.0.1' } = {}) {
  let statusCode = 200;
  const resHeaders = {};
  let payload = null;

  const req = {
    method,
    headers: {
      host: 'localhost:3000',
      'content-type': 'application/json',
      'x-real-ip': ip,
      ...headers
    },
    socket: { remoteAddress: ip },
    body
  };

  const res = {
    setHeader(k, v) { resHeaders[String(k).toLowerCase()] = v; },
    status(code) { statusCode = code; return this; },
    json(data) { payload = data; return this; }
  };

  await fn(req, res);
  return { statusCode, headers: resHeaders, payload };
}
