// Isolated local preview: real schema/RPCs, temporary in-memory data, no cloud services.
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const {createFreshDatabase}=require('../tests/helpers/fresh-database.cjs');
const root=path.resolve(__dirname,'..');
const user='11111111-1111-4111-8111-111111111111';
const port=8124;
const origin=`http://127.0.0.1:${port}`;
const assets=new Set(['index.html','app.js','api.js','invoice-matching.js','rules.js','styles.css']);
const uploads=new Map();
const json=(res,data,status=200)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
const adapter=`const CloudApi=window.FinRefApi;
window.FinRefApi=class extends CloudApi {
  constructor(){super({});this.url=location.origin;this.remember({user:{id:'${user}'},access_token:'local-preview',expires_in:86400});}
  get configured(){return true;}
};`;
async function main(){
  const db=await createFreshDatabase([user]);
  await db.query('insert into profiles values ($1,$2,$3)',[user,'Người nộp thử nghiệm local','applicant']);
  await db.exec('grant insert on storage.objects to authenticated; grant usage,select on all sequences in schema storage to authenticated;');
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[user]);
  await db.exec('set role authenticated');
  let pending=Promise.resolve();
  const server=http.createServer((req,res)=>{
    // Serial requests keep the embedded database and upload metadata consistent.
    pending=pending.then(async()=>{
      res.setHeader('Cache-Control','no-store');
      if(req.headers.host!==`127.0.0.1:${port}`||(req.headers.origin&&req.headers.origin!==origin)) return json(res,{error:'Local access only'},403);
      const url=new URL(req.url,origin),name=url.pathname.slice(1)||'index.html';
      if(req.method==='GET'&&assets.has(name)){
        let content=fs.readFileSync(path.join(root,name));
        if(name==='index.html') content=content.toString().replace('<body>','<body><div style="padding:12px;background:#fff0c2;text-align:center">BẢN TEST LOCAL · Tài khoản mẫu · Dữ liệu mất khi tắt server · Không gọi Azure AI</div>').replace('<script src="api.js"></script>','<script src="api.js"></script><script src="local-adapter.js"></script>');
        res.setHeader('Content-Type',name.endsWith('.html')?'text/html; charset=utf-8':name.endsWith('.css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8');
        return res.end(content);
      }
      if(name==='config.js'||name==='local-adapter.js'){
        res.setHeader('Content-Type','text/javascript');return res.end(name==='config.js'?'window.FINREF_CONFIG={};':adapter);
      }
      if(/^vendor\/pdfjs\/(?:pdf\.min\.mjs|pdf\.worker\.min\.mjs|(?:cmaps|standard_fonts|wasm|iccs)\/[A-Za-z0-9._-]+)$/.test(name)){
        const relative=name.replace('vendor/pdfjs/','');
        const file=path.join(root,'node_modules/pdfjs-dist',relative.endsWith('.mjs')?'build':'',relative);
        res.setHeader('Content-Type',file.endsWith('.mjs')?'text/javascript':file.endsWith('.wasm')?'application/wasm':'application/octet-stream');
        return res.end(fs.readFileSync(file));
      }
      const chunks=[];let size=0;
      for await(const chunk of req){size+=chunk.length;if(size>11*1024*1024)return json(res,{error:'File quá lớn'},413);chunks.push(chunk);}
      const bytes=Buffer.concat(chunks);
      const body=()=>JSON.parse(bytes.toString()||'{}');
      if(url.pathname==='/auth/v1/user')return json(res,{id:user});
      if(url.pathname==='/auth/v1/token')return json(res,{user:{id:user},access_token:'local-preview',expires_in:86400});
      if(url.pathname==='/auth/v1/logout')return json(res,{});
      if(url.pathname==='/rest/v1/profiles')return json(res,(await db.query('select * from profiles where id=$1',[user])).rows);
      if(url.pathname==='/rest/v1/requests'){
        const id=url.searchParams.get('id')?.replace(/^eq\./,'');
        return json(res,(await db.query(id?'select * from requests where id=$1':'select * from requests order by created_at desc limit 200 offset $1',[id||Number(url.searchParams.get('offset')||0)])).rows);
      }
      if(url.pathname==='/rest/v1/audit_events')return json(res,(await db.query('select * from audit_events where request_id=$1 order by id desc limit 50',[url.searchParams.get('request_id')?.replace(/^eq\./,'')])).rows);
      if(url.pathname==='/rest/v1/rpc/submit_request'){
        const b=body();
        return json(res,(await db.query('select * from public.submit_request($1,$2::jsonb,$3,$4,$5)',[b.p_id,JSON.stringify(b.p_payload),b.p_invoice_path,b.p_request_path,b.p_expected_version])).rows[0]);
      }
      if(url.pathname==='/rest/v1/rpc/vendor_directory_list')return json(res,(await db.query('select * from public.vendor_directory_list()')).rows);
      if(url.pathname.startsWith('/storage/v1/object/evidence/')&&req.method==='POST'){
        const key=decodeURIComponent(url.pathname.slice('/storage/v1/object/evidence/'.length));
        await db.query('insert into storage.objects(name,bucket_id) values ($1,$2)',[key,'evidence']);uploads.set(key,bytes);return json(res,{});
      }
      if(url.pathname.startsWith('/storage/v1/object/sign/evidence/')){
        const key=decodeURIComponent(url.pathname.slice('/storage/v1/object/sign/evidence/'.length));
        if(req.method==='POST')return json(res,{signedURL:'/object/sign/evidence/'+key});
        if(!uploads.has(key))return json(res,{error:'PDF not found'},404);
        res.setHeader('Content-Type','application/pdf');return res.end(uploads.get(key));
      }
      if(url.pathname==='/api/analyze-evidence')return json(res,{error:'Bản test local không gọi Azure AI.'},503);
      return json(res,{error:'Not available in local preview'},404);
    }).catch(error=>{if(!res.headersSent)json(res,{error:error.message},400);else res.end();});
  });
  server.listen(port,'127.0.0.1',()=>console.log(`Local preview: ${origin} (temporary database; no cloud writes)`));
  server.on('error',error=>{console.error(error);process.exit(1);});
}
main().catch(error=>{console.error(error);process.exit(1);});
