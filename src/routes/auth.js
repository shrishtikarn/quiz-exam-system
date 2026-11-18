'use strict';

const express = require('express');
const { query, queryOne } = require('../db');
const { HttpError, wrap, text, email: parseEmail } = require('../lib/http');
const { hashPassword, verifyPassword, verifyDecoy, newLinkCode } = require('../lib/auth');
const { FixedWindowLimiter } = require('../lib/ratelimit');
const log = require('../lib/logger');

const PUBLIC_ROLES = new Set(['student', 'parent']);

function publicUser(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    linkCode: row.role === 'student' ? row.link_code : undefined,
  };
}

function isDuplicate(error) {
  return error.code === 'ER_DUP_ENTRY' || /UNIQUE constraint/.test(error.message);
}

function authRoutes(config, auth) {
  const router = express.Router();
  const loginFailures = new FixedWindowLimiter({ limit: config.loginMaxFailures, windowMs: 15 * 60 * 1000 });
  const registrations = new FixedWindowLimiter({ limit: config.registerMaxPerHour, windowMs: 60 * 60 * 1000 });

  router.post('/register', wrap(async (req, res) => {
    if (registrations.isBlocked(req.ip)) throw new HttpError(429, 'Too many new accounts. Try again later.');

    const name = text(req.body.name, 'Name', { max: 120 });
    const email = parseEmail(req.body.email);
    const password = text(req.body.password, 'Password', { min: 8, max: 128 });
    const role = req.body.role;
    if (!PUBLIC_ROLES.has(role)) throw new HttpError(400, 'Choose student or parent');

    const passwordHash = await hashPassword(password);
    const linkCode = role === 'student' ? newLinkCode() : null;

    let result;
    try {
      result = await query(
        'INSERT INTO users (name, email, password_hash, role, link_code) VALUES (?, ?, ?, ?, ?)',
        [name, email, passwordHash, role, linkCode],
      );
    } catch (error) {
      if (isDuplicate(error)) throw new HttpError(409, 'An account with this email already exists');
      throw error;
    }

    registrations.hit(req.ip);
    const user = { id: result.insertId, name, email, role, link_code: linkCode };
    auth.startSession(req, res, user);
    log.info('user_registered', { userId: user.id, role });
    res.status(201).json({ user: publicUser(user) });
  }));

  router.post('/login', wrap(async (req, res) => {
    const email = parseEmail(req.body.email);
    const password = text(req.body.password, 'Password', { max: 128 });
    const key = `${req.ip}|${email}`;

    if (loginFailures.isBlocked(key)) {
      log.warn('login_blocked', { ip: req.ip });
      throw new HttpError(429, 'Too many failed attempts. Try again in 15 minutes.');
    }

    const user = await queryOne('SELECT * FROM users WHERE email = ?', [email]);
    const valid = user ? await verifyPassword(password, user.password_hash) : await verifyDecoy(password);
    if (!valid) {
      loginFailures.hit(key);
      log.warn('login_failed', { ip: req.ip });
      throw new HttpError(401, 'Incorrect email or password');
    }

    loginFailures.reset(key);
    auth.startSession(req, res, user);
    log.info('login_succeeded', { userId: user.id, role: user.role });
    res.json({ user: publicUser(user) });
  }));

  router.post('/logout', (req, res) => {
    auth.endSession(req, res);
    res.status(204).end();
  });

  router.get('/me', auth.requireRole('student', 'parent', 'tutor'), wrap(async (req, res) => {
    const user = await queryOne('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (!user) throw new HttpError(401, 'Please log in');
    res.json({ user: publicUser(user) });
  }));

  return router;
}

module.exports = { authRoutes };
