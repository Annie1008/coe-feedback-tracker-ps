const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { discoverMigrations, runMigrations } = require('../scripts/migrate');

test('discovers SQL migrations in filename order', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-migrations-'));
  fs.writeFileSync(path.join(directory, '010_last.sql'), 'SELECT 10;');
  fs.writeFileSync(path.join(directory, '002_second.sql'), 'SELECT 2;');
  fs.writeFileSync(path.join(directory, 'README.md'), 'ignored');

  assert.deepEqual(
    discoverMigrations(directory).map(migration => migration.version),
    ['002_second', '010_last']
  );
});

test('runs each pending migration once under an advisory lock', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-migrations-'));
  fs.writeFileSync(path.join(directory, '001_first.sql'), 'SELECT 1;');
  fs.writeFileSync(path.join(directory, '002_second.sql'), 'SELECT 2;');
  const queries = [];
  let appliedMigrations = [];
  const client = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (/SELECT version, checksum FROM schema_migrations/.test(sql)) {
        return { rows: appliedMigrations.map(([version, checksum]) => ({ version, checksum })) };
      }
      if (/INSERT INTO schema_migrations/.test(sql)) appliedMigrations.push(params);
      return { rows: [] };
    },
    release() {}
  };
  const pool = { async connect() { return client; } };

  await runMigrations({ pool, migrationsDir: directory });
  await runMigrations({ pool, migrationsDir: directory });

  assert.equal(queries.filter(query => query.sql === 'SELECT 1;').length, 1);
  assert.equal(queries.filter(query => query.sql === 'SELECT 2;').length, 1);
  assert.equal(queries.filter(query => /pg_advisory_lock/.test(query.sql)).length, 2);
  assert.equal(queries.filter(query => /pg_advisory_unlock/.test(query.sql)).length, 2);
  assert.deepEqual(appliedMigrations.map(row => row[0]), ['001_first', '002_second']);
  assert.ok(appliedMigrations.every(row => /^[a-f0-9]{64}$/.test(row[1])));
});

test('rejects an applied migration whose contents changed', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-migrations-'));
  fs.writeFileSync(path.join(directory, '001_first.sql'), 'SELECT changed;');
  const client = {
    async query(sql) {
      if (/SELECT version/.test(sql)) return { rows: [{ version: '001_first', checksum: '0'.repeat(64) }] };
      return { rows: [] };
    },
    release() {}
  };

  await assert.rejects(
    runMigrations({ pool: { async connect() { return client; } }, migrationsDir: directory }),
    /applied migration 001_first has changed/
  );
});

test('releases the migration client even when advisory unlock fails', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-migrations-'));
  let released = false;
  const client = {
    async query(sql) {
      if (/SELECT version/.test(sql)) return { rows: [] };
      if (/pg_advisory_unlock/.test(sql)) throw new Error('unlock failed');
      return { rows: [] };
    },
    release() { released = true; }
  };

  await assert.rejects(
    runMigrations({ pool: { async connect() { return client; } }, migrationsDir: directory }),
    /unlock failed/
  );
  assert.equal(released, true);
});

test('rolls back a failed migration and does not record its version', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-migrations-'));
  fs.writeFileSync(path.join(directory, '001_broken.sql'), 'BROKEN SQL;');
  const queries = [];
  let released = false;
  const client = {
    async query(sql) {
      queries.push(sql);
      if (/SELECT version, checksum FROM schema_migrations/.test(sql)) return { rows: [] };
      if (sql === 'BROKEN SQL;') throw new Error('migration failed');
      return { rows: [] };
    },
    release() { released = true; }
  };

  await assert.rejects(
    runMigrations({ pool: { async connect() { return client; } }, migrationsDir: directory }),
    /migration failed/
  );

  assert.ok(queries.includes('ROLLBACK'));
  assert.equal(queries.some(query => /INSERT INTO schema_migrations/.test(query)), false);
  assert.ok(queries.some(query => /pg_advisory_unlock/.test(query)));
  assert.equal(released, true);
});
