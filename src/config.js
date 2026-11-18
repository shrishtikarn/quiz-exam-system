'use strict';

const fs = require('node:fs');

function intFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value)) throw new Error(`${name} must be a whole number`);
  return value;
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function loadConfig() {
  const caPath = process.env.DB_CA_PATH || '';
  return {
    port: intFromEnv('PORT', 3000),
    version: process.env.APP_VERSION || 'dev',
    instanceId: process.env.INSTANCE_ID || 'local',
    jwtSecret: requireEnv('JWT_SECRET'),
    trustProxyHops: intFromEnv('TRUST_PROXY_HOPS', 1),
    sessionHours: intFromEnv('SESSION_HOURS', 8),
    loginMaxFailures: intFromEnv('LOGIN_MAX_FAILURES', 10),
    registerMaxPerHour: intFromEnv('REGISTER_MAX_PER_HOUR', 30),
    answerGraceSeconds: intFromEnv('ANSWER_GRACE_SECONDS', 5),
    seedOnBoot: process.env.SEED_ON_BOOT === 'true',
    demoPassword: process.env.DEMO_PASSWORD || '',
    demoStudents: intFromEnv('DEMO_STUDENTS', 100),
    db: {
      host: requireEnv('DB_HOST'),
      port: intFromEnv('DB_PORT', 3306),
      user: requireEnv('DB_USER'),
      password: requireEnv('DB_PASSWORD'),
      database: requireEnv('DB_NAME'),
      connectionLimit: intFromEnv('DB_POOL_SIZE', 10),
      ca: caPath ? fs.readFileSync(caPath, 'utf8') : null,
    },
  };
}

module.exports = { loadConfig };
