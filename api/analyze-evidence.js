'use strict';
const {evidenceSchema,buildPrompt,normalizeAnalysis}=require('../ai.js');
const send=(res,status,body)=>{res.statusCode=status;res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify(body));};
const fields=['requesterType','requester','department','budgetCode','purpose','vendor','invoiceNumber','invoiceDate','amount','invoiceType','category'];
function validPayload(p){return p&&Object.keys(p).length===fields.length&&fields.every(k=>k==='amount'?Number.isSafeInteger(p[k])&&p[k]>0&&p[k]<=999999999999:typeof p[k]==='string'&&p[k].trim().length>0&&p[k].length<=1000);}
function extractText(data){
 if(data.status!=='completed') throw new Error('incomplete');
 return (data.output||[]).flatMap(x=>x.content||[]).filter(x=>x.type==='output_text').map(x=>x.text).join('');
}
// Dependency injection is only for tests; no client input selects a transport or key.
function createHandler(env=process.env,fetcher=fetch){return async(req,res)=>{
 if(req.method!=='POST'){res.setHeader('Allow','POST');return send(res,405,{error:'Chỉ hỗ trợ POST.'});}
 const auth=req.headers.authorization||'';
 if(!/^Bearer [^\s]+$/.test(auth)) return send(res,401,{error:'Cần đăng nhập.'});
 const url=(env.SUPABASE_URL||'').replace(/\/$/,'');
 if(!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(url)||!env.SUPABASE_ANON_KEY||!env.SUPABASE_SERVICE_ROLE_KEY||!env.OPENAI_API_KEY) return send(res,503,{error:'Chưa cấu hình đủ AI trên máy chủ. Bạn có thể gửi hồ sơ để thủ quỹ kiểm tra.'});
 const userHeaders={apikey:env.SUPABASE_ANON_KEY,Authorization:auth,'Content-Type':'application/json'};
 const adminHeaders={apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:'Bearer '+env.SUPABASE_SERVICE_ROLE_KEY,'Content-Type':'application/json'};
 const request=(path,options={})=>fetcher(url+path,{redirect:'error',signal:AbortSignal.timeout(15000),headers:userHeaders,...options});
 let assessmentId;
 try{
   const identity=await request('/auth/v1/user');if(!identity.ok)return send(res,401,{error:'Phiên đăng nhập không hợp lệ.'});
   const user=await identity.json();const body=req.body;
   if(!body||!validPayload(body.request)||typeof body.paths?.invoicePath!=='string'||typeof body.paths?.requestPath!=='string')return send(res,400,{error:'Hồ sơ không hợp lệ.'});
   const paths=[body.paths.invoicePath,body.paths.requestPath];
   if(!paths.every((p,i)=>new RegExp('^[0-9a-f-]{36}/[0-9a-f-]{36}/'+(i?'request':'invoice')+'\\.(pdf|jpg|png)$').test(p)&&p.split('/')[0]===user.id)||paths[0].split('/')[1]!==paths[1].split('/')[1])return send(res,400,{error:'Minh chứng phải thuộc cùng hồ sơ và tài khoản.'});
   const reserved=await request('/rest/v1/rpc/reserve_assessment',{method:'POST',body:JSON.stringify({p_payload:body.request,p_invoice_path:paths[0],p_request_path:paths[1]})});
   if(!reserved.ok)return send(res,429,{error:'Chưa thể phân tích. Kiểm tra file đã tải lên và giới hạn 6 lượt/phút, 100 lượt/ngày.'});
   assessmentId=await reserved.json();
   const content=[{type:'input_text',text:'File thứ nhất là hóa đơn, file thứ hai là đơn đề nghị. Chỉ đọc dữ kiện trong file.'}];
   for(const path of paths){
     const response=await request('/storage/v1/object/authenticated/evidence/'+path);
     if(!response.ok||Number(response.headers.get('content-length'))>10485760)throw new Error('storage');
     // Stream with a hard cap instead of trusting Content-Length.
     const reader=response.body.getReader();let size=0;const chunks=[];
     for(;;){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.length;if(size>10485760){await reader.cancel();throw new Error('size');}chunks.push(Buffer.from(chunk.value));}
     const bytes=Buffer.concat(chunks);let mime;
     if(path.endsWith('.pdf')&&bytes.subarray(0,5).toString()==='%PDF-')mime='application/pdf';
     if(path.endsWith('.jpg')&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255)mime='image/jpeg';
     if(path.endsWith('.png')&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))mime='image/png';
     if(!mime)throw new Error('invalid-file');
     const data='data:'+mime+';base64,'+bytes.toString('base64');
     content.push(mime==='application/pdf'?{type:'input_file',filename:path.split('/').pop(),file_data:data}:{type:'input_image',image_url:data});
   }
   const upstream=await fetcher('https://api.openai.com/v1/responses',{method:'POST',redirect:'error',signal:AbortSignal.timeout(45000),headers:{Authorization:'Bearer '+env.OPENAI_API_KEY,'Content-Type':'application/json'},body:JSON.stringify({model:env.OPENAI_MODEL||'gpt-4.1-mini',store:false,instructions:buildPrompt(),input:[{role:'user',content}],text:{format:{type:'json_schema',name:'evidence_analysis',strict:true,schema:evidenceSchema}},max_output_tokens:2200})});
   if(!upstream.ok)throw new Error('upstream');
   const analysis=normalizeAnalysis(JSON.parse(extractText(await upstream.json())),body.request);
   const saved=await request('/rest/v1/agent_assessments?id=eq.'+encodeURIComponent(assessmentId)+'&state=eq.pending',{method:'PATCH',headers:{...adminHeaders,Prefer:'return=representation'},body:JSON.stringify({state:'complete',analysis})});
   if(!saved.ok||(await saved.json()).length!==1)throw new Error('save');
   return send(res,200,{analysis,assessmentId});
 }catch{
   if(assessmentId){try{await request('/rest/v1/agent_assessments?id=eq.'+encodeURIComponent(assessmentId)+'&state=eq.pending',{method:'PATCH',headers:adminHeaders,body:JSON.stringify({state:'failed'})});}catch{}}
   return send(res,502,{error:'Chưa đọc được minh chứng. Hồ sơ sẽ chờ làm rõ; không tự duyệt.'});
 }
};}
module.exports=createHandler();module.exports.createHandler=createHandler;
