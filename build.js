// Builds the static site into dist/ (or --out=<dir>).
// Only allowlisted public files are published; server code, migrations, tests,
// env files, and internal documentation stay outside the public output directory.
const fs = require('fs');
const path = require('path');

const PUBLIC_FILES = ['index.html', 'admin.html', 'branding.css', 'admin.js'];
const PUBLIC_DIRS = ['assets'];
const EXCLUDED_ASSETS = ['assets/ig', 'assets/kmtedi-collage.jpg', 'assets/kmtedi-reference.jpg'];

function buildSite({ root = __dirname, outDir = null, env = process.env } = {}) {
  const out = outDir ? path.resolve(outDir) : path.join(root, 'dist');
  const url = String(env.SUPABASE_URL || '').trim();
  const anonKey = String(env.SUPABASE_ANON_KEY || '').trim();

  if (!url || !anonKey) {
    throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY must be set before building.');
  }
  if (/service_role|sb_secret_/i.test(anonKey)) {
    throw new Error('SUPABASE_ANON_KEY looks like a secret/service_role key. Use the publishable/anon key only.');
  }

  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });

  for (const file of PUBLIC_FILES) {
    fs.copyFileSync(path.join(root, file), path.join(out, file));
  }

  for (const dir of PUBLIC_DIRS) {
    fs.cpSync(path.join(root, dir), path.join(out, dir), {
      recursive: true,
      filter: src => {
        const rel = path.relative(root, src).split(path.sep).join('/');
        return !EXCLUDED_ASSETS.includes(rel) && !rel.endsWith('.DS_Store');
      }
    });
  }

  const config = `// Generated automatically during build\nwindow.KMTEDI_SUPABASE_CONFIG = ${JSON.stringify({ url, anonKey }, null, 2)};\n`;
  fs.writeFileSync(path.join(out, 'supabase-config.js'), config, 'utf8');

  return { out, files: [...PUBLIC_FILES, 'supabase-config.js'], dirs: PUBLIC_DIRS };
}

if (require.main === module) {
  const outArg = process.argv.find(a => a.startsWith('--out='));
  const outDir = outArg ? outArg.slice('--out='.length) : null;
  try {
    const result = buildSite({ outDir });
    console.log(`Built ${result.files.length} public files + ${result.dirs.join(', ')} into ${result.out}.`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = { buildSite, PUBLIC_FILES, PUBLIC_DIRS, EXCLUDED_ASSETS };
