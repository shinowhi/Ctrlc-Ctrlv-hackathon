const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../dist');
if (!fs.existsSync(root)) throw new Error('Run npm run build first. See HUONG-DAN-ONLINE.md');
const allowed = new Set(['index.html','app.js','api.js','rules.js','styles.css','demo.html','demo.js','config.js','vendor/pdfjs/LICENSE']);
const pdfjsAssetPattern = /^vendor\/pdfjs\/(?:pdf\.min\.mjs|pdf\.worker\.min\.mjs|(?:cmaps|standard_fonts|wasm|iccs)\/[A-Za-z0-9._-]+)$/;
const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.wasm':'application/wasm','.bcmap':'application/octet-stream','.pfb':'application/octet-stream','.bin':'application/octet-stream','.icc':'application/octet-stream'};
http.createServer((req,res) => {
  const file = new URL(req.url, 'http://localhost').pathname.slice(1) || 'index.html';
  if (!allowed.has(file) && !pdfjsAssetPattern.test(file)) { res.writeHead(404); res.end(); return; }
  res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-cache');
  fs.createReadStream(path.join(root,file)).pipe(res);
}).listen(8124, '127.0.0.1', () => console.log('Open http://127.0.0.1:8124'));
