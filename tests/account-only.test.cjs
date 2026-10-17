'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('fresh-install setup stays on the pre-guest authenticated-only baseline', () => {
  const manifest = read('supabase/fresh-install-migrations.txt');
  assert.match(manifest.trim().split(/\r?\n/).at(-1), /^20261017-invoice-currency\.sql$/);
  assert.doesNotMatch(manifest, /guest|anonymous/i);

  for (const file of ['web/api.js', 'api/analyze-evidence.js', 'web/app.js', 'web/index.html', 'scripts/build.cjs', '.env.example']) {
    assert.doesNotMatch(read(file), /guest|anonymous|is_guest/i, `${file} should not contain guest-mode behavior`);
  }

  assert.equal(fs.existsSync(path.join(root, 'supabase/migrations/20261016-guest-shared-project.sql')), false);
  assert.equal(fs.existsSync(path.join(root, 'supabase/rollback-guest-shared-project.sql')), false);
});
