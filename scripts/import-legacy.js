const { createPool } = require('../server/db');
const { importLegacyData } = require('../server/legacyImport');

async function runLegacyImport({ pool, snapshotId = process.env.LEGACY_SNAPSHOT_ID } = {}) {
  if (!pool) throw new Error('DATABASE_URL is required to import legacy data');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      const result = await client.query("SELECT payload, updated_at FROM app_data WHERE id = 'main' FOR SHARE");
      if (!result.rows[0]) throw new Error('app_data main payload was not found');
      const sourceUpdatedAt = result.rows[0].updated_at;
      const report = await importLegacyData({
        client,
        payload: result.rows[0].payload,
        sourceUpdatedAt,
        snapshotId: snapshotId || `app_data:main:${new Date(sourceUpdatedAt).toISOString()}`,
        manageTransaction: false
      });
      await client.query('COMMIT');
      return report;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    client.release();
  }
}

async function main() {
  const pool = createPool();
  try {
    const report = await runLegacyImport({ pool });
    console.log(JSON.stringify(report, null, 2));
  } finally {
    if (pool) await pool.end();
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(JSON.stringify({ error: error.message }));
    process.exitCode = 1;
  });
}

module.exports = { runLegacyImport };
