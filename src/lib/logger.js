'use strict';

let baseFields = {};

function configureLogger(fields) {
  baseFields = fields;
}

/** Writes one JSON line. CloudWatch Logs metric filters read these fields. */
function log(level, event, fields = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...baseFields, ...fields });
  if (level === 'error') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

const info = (event, fields) => log('info', event, fields);
const warn = (event, fields) => log('warn', event, fields);
const error = (event, fields) => log('error', event, fields);

module.exports = { configureLogger, info, warn, error };
