const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createPool } = require('../server/db');

const MIGRATION_LOCK_ID = 1184913901;

function discoverMigrations(migrationsDir = path.join(__dirname, '..', 'migrations')) {
  return fs.readdirSync(migrationsDir)
    .filter(file => file.endsWith('.sql'))
    .sort((left, right) => left.localeCompare(right))
    .map(file => ({
      version: path.basename(file, '.sql'),
      sql: fs.readFileSync(path.join(migrationsDir, file), 'utf8')
    }))
    .map(migration => ({
      ...migration,
      checksum: crypto.createHash('sha256').update(migration.sql).digest('hex')
    }));
}

async function runMigrations({ pool, migrationsDir } = {}) {
  if (!pool) throw new Error('DATABASE_URL is required to run migrations');
  const client = await pool.connect();
  let locked = false;

  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    locked = true;
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    const result = await client.query('SELECT version, checksum FROM schema_migrations');
    const applied = new Map(result.rows.map(row => [row.version, row.checksum]));

    for (const migration of discoverMigrations(migrationsDir)) {
      if (applied.has(migration.version)) {
        if (applied.get(migration.version) !== migration.checksum) {
          throw new Error(`applied migration ${migration.version} has changed`);
        }
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query(
          'INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)',
          [migration.version, migration.checksum]
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    try {
      if (locked) await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
    } finally {
      client.release();
    }
  }
}

async function main() {
  const pool = createPool();
  try {
    await runMigrations({ pool });
  } finally {
    if (pool) await pool.end();
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error('[db] migration error:', error);
    process.exitCode = 1;
  });
}

module.exports = { discoverMigrations, runMigrations };
