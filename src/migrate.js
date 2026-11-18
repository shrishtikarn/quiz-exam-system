'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { getPool } = require('./db');
const { seedDatabase } = require('./seed');

const SCHEMA_PATH = path.join(__dirname, '..', 'db', 'schema.sql');
const LOCK_NAME = 'quiz_exam_migration';

function schemaStatements() {
  return fs
    .readFileSync(SCHEMA_PATH, 'utf8')
    .split(/;\s*(?:\n|$)/)
    .map((statement) => statement.trim())
    .filter(Boolean);
}

/** Several instances can boot together, so a database lock lets one do the work at a time. */
async function prepareDatabase(config) {
  const connection = await getPool().getConnection();
  try {
    const [[lock]] = await connection.query('SELECT GET_LOCK(?, 120) AS acquired', [LOCK_NAME]);
    if (Number(lock.acquired) !== 1) throw new Error('Timed out waiting for the migration lock');
    try {
      for (const statement of schemaStatements()) await connection.query(statement);
      if (config.seedOnBoot) await seedDatabase(connection, config);
    } finally {
      await connection.query('SELECT RELEASE_LOCK(?)', [LOCK_NAME]);
    }
  } finally {
    connection.release();
  }
}

module.exports = { prepareDatabase };
