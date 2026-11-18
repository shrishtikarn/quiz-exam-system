'use strict';

const crypto = require('node:crypto');
const { promisify } = require('node:util');
const jwt = require('jsonwebtoken');
const { HttpError } = require('./http');

const scrypt = promisify(crypto.scrypt);
const COOKIE_NAME = 'quiz_session';
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const LINK_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  const [scheme, N, r, p, saltB64, keyB64] = String(stored).split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(keyB64, 'base64');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
  });
  return crypto.timingSafeEqual(actual, expected);
}

/** Spends the same work as a real check so unknown emails are not revealed by timing. */
let decoyHash = null;
async function verifyDecoy(password) {
  if (!decoyHash) decoyHash = await hashPassword(crypto.randomUUID());
  await verifyPassword(password, decoyHash);
  return false;
}

function newLinkCode() {
  const bytes = crypto.randomBytes(10);
  return Array.from(bytes, (byte) => LINK_ALPHABET[byte % LINK_ALPHABET.length]).join('');
}

function isHttps(req) {
  return req.secure || req.get('x-forwarded-proto') === 'https' || req.get('cloudfront-forwarded-proto') === 'https';
}

function cookieHeader(req, value, maxAgeSeconds) {
  const parts = [`${COOKIE_NAME}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSeconds}`];
  if (isHttps(req)) parts.push('Secure');
  return parts.join('; ');
}

function readCookie(req) {
  const header = req.get('cookie') || '';
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === COOKIE_NAME) return part.slice(index + 1).trim();
  }
  return null;
}

function createAuth(config) {
  const maxAge = config.sessionHours * 3600;

  function startSession(req, res, user) {
    const token = jwt.sign({ sub: String(user.id), role: user.role, name: user.name }, config.jwtSecret, {
      algorithm: 'HS256',
      expiresIn: maxAge,
    });
    res.setHeader('Set-Cookie', cookieHeader(req, token, maxAge));
  }

  function endSession(req, res) {
    res.setHeader('Set-Cookie', cookieHeader(req, '', 0));
  }

  function authenticate(req, _res, next) {
    const token = readCookie(req);
    if (token) {
      try {
        const claims = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
        req.user = { id: Number(claims.sub), role: claims.role, name: claims.name };
      } catch {
        req.user = null;
      }
    }
    next();
  }

  const requireRole = (...roles) => (req, _res, next) => {
    if (!req.user) return next(new HttpError(401, 'Please log in'));
    if (!roles.includes(req.user.role)) return next(new HttpError(403, 'You do not have access to this page'));
    return next();
  };

  return { startSession, endSession, authenticate, requireRole };
}

module.exports = { hashPassword, verifyPassword, verifyDecoy, newLinkCode, isHttps, createAuth };
