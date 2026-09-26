const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'dist');
const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || '';
if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(supabaseUrl)) {
  throw new Error('Set SUPABASE_URL to https://your-project.supabase.co');
}
let role;
try { role = JSON.parse(Buffer.from(supabaseAnonKey.split('.')[1], 'base64url')).role; } catch {}
if (!(supabaseAnonKey.startsWith('sb_publishable_') || role === 'anon')) {
  throw new Error('SUPABASE_ANON_KEY must be a publishable key or legacy anon key. Never a secret/service_role key.');
}
fs.mkdirSync(out, { recursive: true });
// Explicit allowlist: SQL, account scripts and .local credentials are never deployed.
for (const name of ['index.html','app.js','api.js','rules.js','styles.css','demo.html','demo.js']) {
  fs.copyFileSync(path.join(root, name), path.join(out, name));
}
const pdfjsRoot = path.join(root, 'node_modules', 'pdfjs-dist');
const pdfjsBuild = path.join(pdfjsRoot, 'build');
const pdfjsOut = path.join(out, 'vendor', 'pdfjs');
fs.mkdirSync(pdfjsOut, { recursive: true });
for (const name of ['pdf.min.mjs','pdf.worker.min.mjs']) {
  fs.copyFileSync(path.join(pdfjsBuild, name), path.join(pdfjsOut, name));
}
for (const name of ['cmaps','standard_fonts','wasm','iccs']) {
  fs.cpSync(path.join(pdfjsRoot, name), path.join(pdfjsOut, name), { recursive: true });
}
fs.copyFileSync(path.join(pdfjsRoot, 'LICENSE'), path.join(pdfjsOut, 'LICENSE'));
fs.writeFileSync(path.join(out, 'config.js'), 'window.FINREF_CONFIG = ' + JSON.stringify({supabaseUrl, supabaseAnonKey}) + ';\n');
console.log('Built public assets in dist/. No account credentials included.');
