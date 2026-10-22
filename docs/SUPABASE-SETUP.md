# Supabase setup

## 1. Create project

Create a new Supabase project. Keep the database password in your password manager.

## 2. Apply SQL

In Supabase Dashboard → SQL Editor, run these files in order:

1. `supabase/migrations/20261022000000_initial_schema.sql`
2. `supabase/seed.sql`

## 3. Configure Google login

In Authentication → Providers → Google:

- Enable Google.
- Add the Google OAuth client ID and secret created in Google Cloud.
- Add the Supabase callback URL shown by Supabase.
- In Authentication → URL Configuration, add:
  - local URL, if used
  - production URL
  - production URL + `/admin.html`

The application requests `hd=mail.ugm.ac.id`, but the database trigger is the actual domain enforcement. Do not rely only on Google UI hints.

## 4. Browser config

Copy `supabase-config.example.js` to `supabase-config.js` and fill:

- Project URL
- Publishable anon key

The anon key is safe for a browser client when RLS and RPC permissions are configured as in the migration. Never use the `service_role` key in the browser.

## 5. Bootstrap panitia admin

1. Sign in once from `/admin.html` using the panitia's `@mail.ugm.ac.id` account.
2. In SQL Editor, run:

```sql
update public.profiles
set role = 'admin'
where email = 'panitia@mail.ugm.ac.id';
```

Replace the email with the real panitia account. Never put the account password in this repository.

## 6. Candidate media

Upload candidate photos to Storage → `candidate-media`. Copy each public URL into `candidates.photo_url`.

## 7. Operational flow

1. Edit candidate content.
2. Keep `voting_open = false` while preparing.
3. Open voting from `admin.html`.
4. Close voting after the deadline.
5. Verify the admin result totals.
6. Publish results from `admin.html`.

The `votes` table intentionally has no voter identity column. The account lock is stored in `profiles.has_voted`; the vote row only stores candidate and timestamp. The `cast_vote` RPC updates the lock and inserts the vote in one transaction.
