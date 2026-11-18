'use strict';

/** Formats a Date as a UTC MySQL DATETIME string. */
function toSql(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

/** Reads a UTC MySQL DATETIME string as a Date. */
function fromSql(value) {
  return value ? new Date(`${String(value).replace(' ', 'T')}Z`) : null;
}

function isoFromSql(value) {
  const date = fromSql(value);
  return date ? date.toISOString() : null;
}

module.exports = { toSql, fromSql, isoFromSql };
