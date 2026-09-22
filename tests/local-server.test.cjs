const test=require('node:test');const assert=require('node:assert/strict');
const {createServer}=require('../scripts/serve.cjs');
test('Local server routes JSON to the same AI handler and protects private files',async()=>{
 let calls=0;
 const server=createServer(async(req,res)=>{calls++;assert.equal(req.body.request.amount,1000);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({assessmentId:'test-id'}));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin='http://127.0.0.1:'+server.address().port;
 try{
  let r=await fetch(origin+'/api/analyze-evidence',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({request:{amount:1000}})});
  assert.equal(r.status,200);assert.equal((await r.json()).assessmentId,'test-id');
  for(const [headers,body,status] of [[{Origin:'https://evil.test','Content-Type':'application/json'},'{}',403],[{Origin:origin,'Content-Type':'application/json'},'{',400],[{Origin:origin,'Content-Type':'application/json'},'x'.repeat(32769),413]]){
   r=await fetch(origin+'/api/analyze-evidence',{method:'POST',headers,body});assert.equal(r.status,status);
  }
  assert.equal(calls,1);
  for(const file of ['.env.local','ai-provider.cjs','supabase/schema.sql'])assert.equal((await fetch(origin+'/'+file)).status,404);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
