const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../dist');
if (!fs.existsSync(root)) throw new Error('Run npm run build first. See HUONG-DAN-ONLINE.md');
const allowed = new Set(['index.html','app.js','api.js','rules.js','verify-ui.js','styles.css','demo.html','demo.js','config.js']);
const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'};
http.createServer((req,res) => {
  const file = new URL(req.url, 'http://localhost').pathname.slice(1) || 'index.html';
  if (!allowed.has(file)) { res.writeHead(404); res.end(); return; }
  res.setHeader('Content-Type', types[path.extname(file)]);
  res.setHeader('Cache-Control', 'no-cache');
  fs.createReadStream(path.join(root,file)).pipe(res);
}).listen(8124, '127.0.0.1', () => console.log('Open http://127.0.0.1:8124'));
