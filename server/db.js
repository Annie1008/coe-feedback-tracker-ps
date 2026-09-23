const { Pool } = require('pg');

function createPool(databaseUrl = process.env.DATABASE_URL) {
  if (!databaseUrl) return null;
  const isLocal = /localhost|127\.0\.0\.1/.test(databaseUrl);
  return new Pool({
    connectionString: databaseUrl,
    ssl: isLocal ? false : { rejectUnauthorized: false }
  });
}

module.exports = { createPool };
