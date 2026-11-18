'use strict';

const { loadConfig } = require('./config');
const { initPool, closePool } = require('./db');
const { createApp } = require('./app');
const { prepareDatabase } = require('./migrate');
const log = require('./lib/logger');

const RETRY_DELAY_MS = 5000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function prepareWithRetry(config, state) {
  while (!state.stopping) {
    try {
      await prepareDatabase(config);
      state.ready = true;
      log.info('app_ready');
      return;
    } catch (error) {
      log.error('database_prepare_failed', { message: error.message });
      await sleep(RETRY_DELAY_MS);
    }
  }
}

function main() {
  const config = loadConfig();
  log.configureLogger({ service: 'quiz-exam', version: config.version, instance: config.instanceId });
  initPool(config.db);

  const state = { ready: false, stopping: false };
  const server = createApp(config, state).listen(config.port, () => {
    log.info('app_listening', { port: config.port });
  });
  // Longer than the load balancer idle timeout, so it never reuses a closed connection.
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;

  prepareWithRetry(config, state);

  const shutdown = (signal) => {
    if (state.stopping) return;
    state.stopping = true;
    state.ready = false;
    log.info('app_stopping', { signal });
    server.close(async () => {
      await closePool().catch(() => {});
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 25000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
