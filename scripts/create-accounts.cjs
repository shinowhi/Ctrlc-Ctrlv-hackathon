/* Run locally only. Never deploy or put the admin key in a browser. */
const fs=require('node:fs');
const path=require('node:path');
const {randomBytes}=require('node:crypto');
const accounts=[
  {email:'nopdon@finref.test',role:'applicant',display_name:'Người nộp đơn mẫu'},
  {email:'thuquy@finref.test',role:'treasurer',display_name:'Quản lý tài chính mẫu'},
  {email:'gdtc@finref.test',role:'cfo',display_name:'Người đứng đầu nhánh tài chính mẫu'}
];
function cleanInput(value) {
  const text=String(value||'').trim();
  return ((text.startsWith('"')&&text.endsWith('"'))||(text.startsWith("'")&&text.endsWith("'"))) ? text.slice(1,-1).trim() : text;
}
function normalizeUrl(value) {
  const text=cleanInput(value);
  if(!text) throw new Error('Project URL is empty. Paste the https://YOUR-PROJECT.supabase.co URL at the FIRST prompt.');
  let parsed;try{parsed=new URL(text);}catch{throw new Error('Invalid Project URL. Copy API URL, including https://. Do not paste the key here.');}
  if(parsed.protocol!=='https:'||!/^([a-z0-9-]+)\.supabase\.co$/.test(parsed.hostname)||parsed.username||parsed.password||parsed.port||parsed.search||parsed.hash||!['','/','/rest/v1','/rest/v1/'].includes(parsed.pathname)) {
    throw new Error('Invalid Project URL. Use https://YOUR-PROJECT.supabase.co from Data API, not the dashboard URL or postgresql connection string.');
  }
  return parsed.origin;
}
function normalizeKey(value) {
  const key=cleanInput(value);
  if(!key) throw new Error('Admin key is empty. Paste Secret key or legacy service_role at the SECOND prompt.');
  if(key.startsWith('sb_publishable_')) throw new Error('This is a Publishable key. Account creation requires Secret key or legacy service_role.');
  if(/^sb_secret_[A-Za-z0-9_-]+$/.test(key)) return key;
  let role;try{role=JSON.parse(Buffer.from(key.split('.')[1],'base64url')).role;}catch{}
  if(role==='service_role' && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(key)) return key;
  throw new Error('Invalid admin key format. Copy the full Secret key (sb_secret_...) or legacy service_role; not the masked dots, key name, or database password.');
}
async function main() {
  const url=normalizeUrl(process.env.SUPABASE_URL);
  const key=normalizeKey(process.env.SUPABASE_SERVICE_ROLE_KEY);
  const folder=path.resolve(__dirname,'../.local');fs.mkdirSync(folder,{recursive:true});
  const credentialFile=path.join(folder,'accounts.txt');
  async function call(route,method='GET',body) {
    const res=await fetch(url+route,{method,signal:AbortSignal.timeout(60000),headers:{apikey:key,...(key.startsWith('sb_secret_')?{}:{Authorization:'Bearer '+key}),'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
    const text=await res.text(); let data;try{data=JSON.parse(text);}catch{data={};}
    if(!res.ok) throw new Error('Supabase '+res.status+': '+(data.msg||data.message||data.error_description||'Check project URL/key and schema.'));
    return data;
  }
  // Check schema before creating any accounts.
  await call('/rest/v1/profiles?select=id&limit=1');
  const existing=[];
  for(let page=1;;page++) {
    const data=await call('/auth/v1/admin/users?page='+page+'&per_page=100');
    existing.push(...data.users);
    if(data.users.length<100) break;
  }
  for(const account of accounts) {
    let user=existing.find(u=>u.email?.toLowerCase()===account.email);
    if(!user) {
      const password=randomBytes(18).toString('base64url')+'aA7!';
      const data=await call('/auth/v1/admin/users','POST',{email:account.email,password,email_confirm:true});
      user=data.user||data;
      // Save immediately: retrying later must not overwrite passwords.
      fs.appendFileSync(credentialFile,`Project: ${url}\nEmail: ${account.email}\nRole: ${account.role}\nPassword: ${password}\n\n`,{mode:0o600});
    }
    const profiles=await call('/rest/v1/profiles?id=eq.'+user.id+'&select=id,role');
    if(profiles.length && profiles[0].role!==account.role) throw new Error('Existing account has another role: '+account.email+'. No role was overwritten.');
    if(!profiles.length) await call('/rest/v1/profiles','POST',{id:user.id,role:account.role,display_name:account.display_name});
    console.log('Ready: '+account.email+' ('+account.role+')');
  }
  console.log('New passwords saved locally in .local/accounts.txt. Existing passwords were not reset.');
}
if(require.main===module) {
  if(process.argv[2]==='--check-url') {
    try{console.log(normalizeUrl(process.argv[3]));}catch(e){console.error(e.message);process.exitCode=1;}
  } else main().catch(e=>{console.error(e.message);process.exitCode=1;});
}
module.exports={accounts,normalizeUrl,normalizeKey};
