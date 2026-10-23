# KMTEDI Pemilwa

Static public page (`index.html`), admin (`admin.html`), Vercel API routes, and Supabase. Production: https://kmtedi-pemilwa.vercel.app.

## Branding

- Shared palette and overrides live in `branding.css`, loaded after each page's existing style block.
- Media team primary colors: burgundy `#250014`, navy `#000113`.
- Secondary accents: amber `#FFB42B`, orange `#E46527`. Keep these as accents, not full-page backgrounds.
- Supplied transparent white logo: `assets/kmtedi-logo.png`. Preserve the mark; show on dark surfaces. Favicon adds a navy backing.
- Artwork source: user-supplied `Assets media ` directory (name includes a trailing space); original files remain outside the repository.
- `media-spark.webp`, `media-lotus.webp`, `media-star.webp`, `media-petals.webp` are optimized transparent exports. Source PNGs remain untouched. Star and lotus are available in assets but not displayed on the page per user preference.
- Public page section rhythm:
  - Hero: Dark burgundy/navy with KMTEDI logo, spark, and petals artwork.
  - Marquee: Vibrant orange ribbon with dark typography.
  - Section 01 / INFO (Kenali Acaranya): Warm cream (`#FFF9EF`) bright section with dark burgundy typography.
  - Section 02 / CALON (Kenali Calonmu): Vibrant orange (`#E46527`) background with dark navy cards and amber tags.
  - Section 03 / TIMELINE (Alur Pemilwa): Deep burgundy red (`#250014`) background with cream and amber typography.
  - Section 04 / STATUS (Bilik Suara): Dark navy (`#000113`) background with golden-yellow status and countdown box.
  - Footer: Dark navy (`#000113`).
- Use decoration sparingly, with empty alt text, hidden from assistive technology, and no pointer events. Preserve admin-configured hero imagery and copy.

## Verification and scope

- `npm test`: branding/static regression tests.
- `npm run build` generates ignored `supabase-config.js` from deployment environment variables; do not overwrite local config without configured env.
- Check public/admin at 320, 390, 768, and 1440 px. Date inputs must stack on small screens.
- Test countdown transitions with in-browser temporary state only. Never change production schedule or create votes just to test styling.
- Branding changes must not alter inline application JavaScript, API routes, schema, voter records or election settings.
- A branding test is not a security audit of OTP or duplicate-vote behavior. Do not infer security guarantees from visual tests.
- Never commit service credentials, admin secrets, or session tokens.
