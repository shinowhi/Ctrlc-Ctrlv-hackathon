const test=require('node:test');const assert=require('node:assert/strict');const Api=require('../api.js');
const memory=()=>({getItem:()=>null,setItem:()=>{},removeItem:()=>{}});
test('Expired session refreshes once for concurrent reads',async()=>{
  const previous=global.fetch;let refreshCount=0;let reads=0;
  global.fetch=async(url,options)=>{
    if(url.includes('grant_type=refresh_token')){refreshCount++;return new Response(JSON.stringify({access_token:'fresh',refresh_token:'next',expires_in:3600}));}
    assert.equal(options.headers.Authorization,'Bearer fresh');reads++;return new Response('[]');
  };
  try{
    const api=new Api({supabaseUrl:'https://test.supabase.co',supabaseAnonKey:'public'},memory());
    api.remember({access_token:'old',refresh_token:'refresh',expires_at:1});
    await Promise.all([api.list(),api.list()]);assert.equal(refreshCount,1);assert.equal(reads,2);
  }finally{global.fetch=previous;}
});
test('Logout clears local tokens when network is unavailable',async()=>{
  const previous=global.fetch;global.fetch=async()=>{throw new Error('offline');};
  try{const api=new Api({},memory());api.remember({access_token:'a',expires_at:Date.now()/1000+300});await assert.rejects(api.logout());assert.equal(api.session,null);}finally{global.fetch=previous;}
});
test('A failed write is surfaced; it is not reported as successful',async()=>{
  const previous=global.fetch;global.fetch=async()=>new Response(JSON.stringify({message:'stale version'}),{status:400});
  try{const api=new Api({},memory());api.remember({access_token:'a',expires_at:Date.now()/1000+300});await assert.rejects(api.rpc('review_request',{}),/stale version/);}finally{global.fetch=previous;}
});
test('Publishable key is sent without pretending it is a user JWT at login',async()=>{
  const previous=global.fetch;let checked=false;
  global.fetch=async(url,opts)=>{assert.equal(opts.headers.apikey,'sb_publishable_test');assert.equal(opts.headers.Authorization,undefined);checked=true;return new Response(JSON.stringify({error_description:'Invalid login credentials'}),{status:400});};
  try{const api=new Api({supabaseUrl:'https://test.supabase.co',supabaseAnonKey:'sb_publishable_test'},memory());await assert.rejects(api.login('x@y.test','wrong'));assert.ok(checked);}finally{global.fetch=previous;}
});
