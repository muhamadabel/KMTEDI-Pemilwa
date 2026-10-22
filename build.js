const fs = require('fs');

const url = process.env.SUPABASE_URL || 'https://YOUR_PROJECT_REF.supabase.co';
const anonKey = process.env.SUPABASE_ANON_KEY || 'YOUR_SUPABASE_ANON_KEY';

const content = `// Generated automatically during build
window.KMTEDI_SUPABASE_CONFIG = {
  url: '${url}',
  anonKey: '${anonKey}'
};
`;

fs.writeFileSync('supabase-config.js', content, 'utf8');
console.log('Generated supabase-config.js successfully.');
