const assert = require('node:assert/strict');
const test = require('node:test');

const { createPool } = require('../server/db');

test('uses non-SSL connections locally and SSL for Heroku-style URLs', async () => {
  const local = createPool('postgres://user:pass@localhost:5432/app');
  const remote = createPool('postgres://user:pass@example.com:5432/app');

  try {
    assert.equal(local.options.ssl, false);
    assert.deepEqual(remote.options.ssl, { rejectUnauthorized: false });
  } finally {
    await local.end();
    await remote.end();
  }
});
