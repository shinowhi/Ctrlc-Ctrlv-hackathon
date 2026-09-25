const test=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const os=require('node:os');const {spawnSync}=require('node:child_process');
const publicFiles=['index.html','app.js','api.js','rules.js','styles.css','demo.html','demo.js'];
function fixture(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'finref-build-test-'));
  fs.mkdirSync(path.join(root,'scripts'));fs.mkdirSync(path.join(root,'.local'));
  fs.writeFileSync(path.join(root,'.local/accounts.txt'),'SENSITIVE TEST FIXTURE');
  fs.copyFileSync(path.resolve(__dirname,'../scripts/build.cjs'),path.join(root,'scripts/build.cjs'));
  for(const file of publicFiles)fs.writeFileSync(path.join(root,file),'test');
  return root;
}
test('Build copies public assets only',()=>{
  const root=fixture();const result=spawnSync(process.execPath,[path.join(root,'scripts/build.cjs')],{env:{...process.env,SUPABASE_URL:'https://test.supabase.co',SUPABASE_ANON_KEY:'sb_publishable_test'},encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  assert.deepEqual(fs.readdirSync(path.join(root,'dist')).sort(),[...publicFiles,'config.js'].sort());
  assert.ok(!fs.readFileSync(path.join(root,'dist/config.js'),'utf8').includes('SENSITIVE'));
});
test('Build refuses admin or missing keys',()=>{
  const root=fixture();const adminJWT='e30.'+Buffer.from(JSON.stringify({role:'service_role'})).toString('base64url')+'.sig';
  for(const key of ['', 'sb_secret_never_public',adminJWT]){
    const result=spawnSync(process.execPath,[path.join(root,'scripts/build.cjs')],{env:{...process.env,SUPABASE_URL:'https://test.supabase.co',SUPABASE_ANON_KEY:key},encoding:'utf8'});
    assert.notEqual(result.status,0);assert.ok(!fs.existsSync(path.join(root,'dist')));
  }
});
