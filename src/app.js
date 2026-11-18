'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const { query } = require('./db');
const { createAuth, isHttps } = require('./lib/auth');
const { HttpError } = require('./lib/http');
const log = require('./lib/logger');
const { authRoutes } = require('./routes/auth');
const { studentRoutes } = require('./routes/student');
const { parentRoutes } = require('./routes/parent');
const { tutorRoutes } = require('./routes/tutor');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

function securityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  next();
}

function requestLogger(req, res, next) {
  // Routers rewrite req.url while they run, so the full path is kept from the start.
  const requestPath = req.path;
  if (requestPath.startsWith('/health')) return next();
  const started = process.hrtime.bigint();
  const requestId = crypto.randomUUID();
  res.setHeader('X-Request-Id', requestId);
  res.on('finish', () => {
    if (!requestPath.startsWith('/api/')) return;
    log.info('http_request', {
      requestId,
      method: req.method,
      path: requestPath,
      status: res.statusCode,
      ms: Number((process.hrtime.bigint() - started) / 1000000n),
      role: req.user ? req.user.role : 'anonymous',
    });
  });
  return next();
}

/** Together with SameSite=Strict cookies this blocks cross-site form posts. */
function requireJson(req, _res, next) {
  const changesData = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  const hasBody = Number(req.get('content-length') || 0) > 0;
  if (changesData && hasBody && !req.is('application/json')) {
    return next(new HttpError(415, 'Send JSON'));
  }
  return next();
}

function createApp(config, state) {
  const app = express();
  const auth = createAuth(config);

  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxyHops);
  app.use(securityHeaders);
  app.use(requestLogger);

  // The load balancer uses this. It stays independent of the database once started,
  // so a database outage does not make Auto Scaling replace healthy instances.
  app.get('/health', (_req, res) => {
    res.status(state.ready ? 200 : 503).json({
      status: state.ready ? 'ok' : 'starting',
      version: config.version,
      instance: config.instanceId,
    });
  });

  app.get('/health/db', async (_req, res) => {
    const started = Date.now();
    try {
      await query('SELECT 1');
      res.json({ status: 'ok', ms: Date.now() - started });
    } catch (error) {
      log.error('db_health_failed', { message: error.message });
      res.status(503).json({ status: 'unavailable' });
    }
  });

  app.use('/api', requireJson, express.json({ limit: '100kb' }), auth.authenticate);
  app.use('/api/auth', authRoutes(config, auth));
  app.use('/api/student', studentRoutes(config, auth));
  app.use('/api/parent', parentRoutes(auth));
  app.use('/api/tutor', tutorRoutes(auth));
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found')));

  app.use(express.static(PUBLIC_DIR, { maxAge: '5m', index: 'index.html' }));
  app.use((req, res, next) => {
    if (req.method !== 'GET') return next(new HttpError(404, 'Not found'));
    return res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });

  // eslint-disable-next-line no-unused-vars
  app.use((error, req, res, _next) => {
    const parseFailure = error.type === 'entity.parse.failed' || error.type === 'entity.too.large';
    const status = error.status || (parseFailure ? 400 : 500);
    if (status >= 500) {
      log.error('http_error', { method: req.method, path: req.path, status, message: error.message });
    }
    const message = status >= 500 ? 'Something went wrong. Please try again.' : error.message;
    res.status(status).json({ error: message });
  });

  return app;
}

module.exports = { createApp };
