// Builds the static site into dist/. Only files listed here are published;
// everything else in the repo (docs, migrations, tests, briefs) stays private.
const fs = require('fs');
const path = require('path');

const root = __dirname;
const out = path.join(root, 'dist');
const PUBLIC_FILES = ['index.html', 'admin.html', 'branding.css', 'motifs.css', 'boot.js', 'app.js', 'admin.js'];
const PUBLIC_DIRS = ['assets'];
// Referensi desain (screenshot feed) tidak ikut dipublikasikan
const EXCLUDED_ASSETS = ['assets/ig', 'assets/kmtedi-collage.jpg', 'assets/kmtedi-reference.jpg'];

const url = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
if (!url || !anonKey) {
  console.error('SUPABASE_URL and SUPABASE_ANON_KEY must be set.');
  process.exit(1);
}
if (/service_role|sb_secret_/.test(anonKey)) {
  console.error('SUPABASE_ANON_KEY looks like a secret key. Use the publishable/anon key only.');
  process.exit(1);
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const file of PUBLIC_FILES) fs.copyFileSync(path.join(root, file), path.join(out, file));
for (const dir of PUBLIC_DIRS) {
  fs.cpSync(path.join(root, dir), path.join(out, dir), {
    recursive: true,
    filter: src => {
      const rel = path.relative(root, src).split(path.sep).join('/');
      return !EXCLUDED_ASSETS.includes(rel) && !rel.endsWith('.DS_Store');
    }
  });
}

const config = `// Generated automatically during build
window.KMTEDI_SUPABASE_CONFIG = ${JSON.stringify({ url, anonKey }, null, 2)};
`;
fs.writeFileSync(path.join(out, 'supabase-config.js'), config, 'utf8');
console.log(`Built ${PUBLIC_FILES.length} files + ${PUBLIC_DIRS.join(', ')} into dist/.`);
