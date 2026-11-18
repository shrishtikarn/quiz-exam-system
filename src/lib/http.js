'use strict';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Passes rejected promises from async route handlers to the error middleware. */
const wrap = (handler) => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next);
};

function toId(value, label = 'id') {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, `Invalid ${label}`);
  return id;
}

function text(value, label, { min = 1, max = 500 } = {}) {
  if (typeof value !== 'string') throw new HttpError(400, `${label} is required`);
  const trimmed = value.trim();
  if (trimmed.length < min) throw new HttpError(400, `${label} is required`);
  if (trimmed.length > max) throw new HttpError(400, `${label} must be ${max} characters or fewer`);
  return trimmed;
}

function optionalText(value, label, max = 2000) {
  if (value === undefined || value === null || value === '') return null;
  return text(value, label, { min: 0, max });
}

function integer(value, label, { min, max }) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new HttpError(400, `${label} must be a whole number from ${min} to ${max}`);
  }
  return number;
}

function email(value) {
  const normalised = text(value, 'Email', { max: 190 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalised)) throw new HttpError(400, 'Enter a valid email address');
  return normalised;
}

module.exports = { HttpError, wrap, toId, text, optionalText, integer, email };
