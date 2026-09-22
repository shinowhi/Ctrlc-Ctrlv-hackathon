const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const analyzeEvidence = require('../api/analyze-evidence.js');
const root = path.resolve(__dirname, '../dist');
const allowed = new Set(['index.html','app.js','api.js','rules.js','verify-ui.js','styles.css','demo.html','demo.js','config.js']);
const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'};
function createServer(handler=analyzeEvidence) {
  return http.createServer(async(req,res) => {
    res.setHeader('X-Content-Type-Options','nosniff');
    const send=(status,error)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({error}));};
    if(!/^(127\.0\.0\.1|localhost):\d+$/.test(req.headers.host||''))return send(403,'Host không hợp lệ.');
    const file = new URL(req.url, 'http://localhost').pathname.slice(1) || 'index.html';
    if(file==='api/analyze-evidence') {
      if(req.method!=='POST'){res.setHeader('Allow','POST');return send(405,'Chỉ hỗ trợ POST.');}
      if(req.headers.origin!==`http://${req.headers.host}`||req.headers['content-type']?.split(';')[0]!=='application/json')return send(403,'Yêu cầu phải xuất phát từ ứng dụng local.');
      try {
        let size=0;const chunks=[];
        for await(const chunk of req){size+=chunk.length;if(size>32768)return send(413,'Nội dung yêu cầu quá lớn.');chunks.push(chunk);}
        try{req.body=JSON.parse(Buffer.concat(chunks).toString());}catch{return send(400,'JSON không hợp lệ.');}
        await handler(req,res);
      }catch{if(!res.writableEnded)send(503,'Không xử lý được yêu cầu AI. Hồ sơ cần người kiểm tra.');}
      return;
    }
    if(req.method!=='GET'&&req.method!=='HEAD')return send(405,'Chỉ hỗ trợ GET/HEAD.');
    if(!allowed.has(file))return send(404,'Không tìm thấy.');
    res.setHeader('Content-Type', types[path.extname(file)]);
    res.setHeader('Cache-Control', 'no-cache');
    const stream=fs.createReadStream(path.join(root,file));
    stream.on('error',()=>{if(!res.headersSent)send(404,'Chạy build trước khi mở ứng dụng.');else res.end();});
    stream.pipe(res);
  });
}
if(require.main===module) {
  if(!fs.existsSync(root))throw new Error('Run node scripts/build.cjs first. See HUONG-DAN-ONLINE.md');
  const port=Number(process.env.FINREF_PORT||8124);
  if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('FINREF_PORT must be 1024..65535.');
  createServer().listen(port,'127.0.0.1',()=>console.log(`Open http://127.0.0.1:${port}`));
}
module.exports={createServer};
