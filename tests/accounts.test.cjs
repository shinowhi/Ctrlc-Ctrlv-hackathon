const test=require('node:test');const assert=require('node:assert/strict');
const {accounts,normalizeUrl,normalizeKey}=require('../scripts/create-accounts.cjs');
test('Three distinct accounts and roles; no embedded passwords',()=>{
  assert.equal(new Set(accounts.map(a=>a.email)).size,3);
  assert.deepEqual(accounts.map(a=>a.role),['applicant','treasurer','cfo']);
  assert.ok(accounts.every(a=>!('password' in a)));
});
test('Project URL accepts whitespace, quotes and REST API suffix',()=>{
  for(const value of [' https://example.supabase.co/ ', '"https://example.supabase.co/rest/v1"', "'https://example.supabase.co/rest/v1/'"]) assert.equal(normalizeUrl(value),'https://example.supabase.co');
});
test('Invalid URLs fail without echoing input',()=>{
  for(const value of ['', 'https://supabase.com/dashboard/project/test','postgresql://secret@host/db','https://example.supabase.co?secret=foo','sb_secret_TEST','https://example.supabase.co.attacker.test','https://user:pass@example.supabase.co']) {
    assert.throws(()=>normalizeUrl(value),e=>/Project URL/.test(e.message)&&!e.message.includes('sb_secret_TEST')&&!e.message.includes('secret=foo'));
  }
});
test('Admin key validation separates empty, public and secret keys',()=>{
  assert.throws(()=>normalizeKey('  '),/empty/);
  assert.throws(()=>normalizeKey('sb_publishable_ABC'),/Publishable/);
  assert.throws(()=>normalizeKey('********'),/Invalid admin key format/);
  assert.equal(normalizeKey(' "sb_secret_EXAMPLE-abc_123" '),'sb_secret_EXAMPLE-abc_123');
  const jwt='e30.'+Buffer.from(JSON.stringify({role:'service_role'})).toString('base64url')+'.abc';
  assert.equal(normalizeKey(jwt),jwt);
});
