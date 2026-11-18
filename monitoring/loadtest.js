#!/usr/bin/env node
'use strict';

/*
 * Simulates an exam rush with the seeded demo students.
 * Usage:
 *   node monitoring/loadtest.js --url http://host --password SECRET \
 *     --stages 10:60,30:120,60:180,0:30 --out result.json
 * Each stage is virtual users:seconds. Needs Node.js 20 or newer and no packages.
 */
const fs = require('node:fs');
const path = require('node:path');

function parseArgs(argv) {
  const args = { stages: '10:60,30:120,60:180,0:30', think: '1000', subject: 'Cloud Computing', questions: '10' };
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index].startsWith('--')) throw new Error(`Unexpected argument ${argv[index]}`);
    args[argv[index].slice(2)] = argv[index + 1];
  }
  args.password = args.password || process.env.DEMO_PASSWORD;
  if (!args.url || !args.password) throw new Error('--url and --password are required');
  args.url = args.url.replace(/\/$/, '');
  args.stages = args.stages.split(',').map((stage) => {
    const [users, seconds] = stage.split(':').map(Number);
    if (!Number.isInteger(users) || !(seconds > 0)) throw new Error(`Bad stage ${stage}`);
    return { users, seconds };
  });
  args.think = Number(args.think);
  args.questions = Number(args.questions);
  return args;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function percentile(sorted, fraction) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function describe(latencies) {
  const sorted = [...latencies].sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  const round = (value) => (value === null ? null : Math.round(value * 10) / 10);
  return {
    averageMs: round(sorted.length ? total / sorted.length : null),
    p50Ms: round(percentile(sorted, 0.5)),
    p95Ms: round(percentile(sorted, 0.95)),
    p99Ms: round(percentile(sorted, 0.99)),
    maxMs: round(sorted.length ? sorted[sorted.length - 1] : null),
  };
}

class Recorder {
  constructor() {
    this.startedAt = Date.now();
    this.endpoints = new Map();
    this.buckets = new Map();
  }

  add(name, ms, outcome) {
    const endpoint = this.endpoints.get(name) || { latencies: [], ok: 0, expected: 0, clientErrors: 0, serverErrors: 0, networkErrors: 0 };
    endpoint.latencies.push(ms);
    endpoint[outcome] += 1;
    this.endpoints.set(name, endpoint);

    const second = Math.floor((Date.now() - this.startedAt) / 10000) * 10;
    const bucket = this.buckets.get(second) || { latencies: [], failures: 0 };
    bucket.latencies.push(ms);
    if (outcome === 'serverErrors' || outcome === 'networkErrors') bucket.failures += 1;
    this.buckets.set(second, bucket);
  }
}

class Session {
  constructor(baseUrl, recorder) {
    this.baseUrl = baseUrl;
    this.recorder = recorder;
    this.cookie = '';
  }

  async call(name, method, route, body, expectedStatuses = []) {
    const started = performance.now();
    let outcome = 'networkErrors';
    try {
      const response = await fetch(`${this.baseUrl}${route}`, {
        method,
        headers: {
          ...(this.cookie ? { cookie: this.cookie } : {}),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
      const text = await response.text();
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) this.cookie = setCookie.split(';')[0];
      if (response.ok) outcome = 'ok';
      else if (expectedStatuses.includes(response.status)) outcome = 'expected';
      else outcome = response.status >= 500 ? 'serverErrors' : 'clientErrors';
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = null;
      }
      return { ok: response.ok, status: response.status, data };
    } catch {
      return { ok: false, status: 0, data: null };
    } finally {
      this.recorder.add(name, performance.now() - started, outcome);
    }
  }

  login(email, password) {
    return this.call('login', 'POST', '/api/auth/login', { email, password });
  }
}

async function prepareExam(args, recorder) {
  const tutor = new Session(args.url, recorder);
  const login = await tutor.login('tutor@demo.quiz', args.password);
  if (!login.ok) throw new Error(`Tutor login failed with status ${login.status}`);
  const created = await tutor.call('tutor_create', 'POST', '/api/tutor/exams', {
    title: `Load test ${new Date().toISOString()}`,
    subject: args.subject,
    durationMinutes: 60,
    passPercent: 40,
  });
  if (!created.ok) throw new Error(`Could not create the exam (status ${created.status})`);
  const { examId } = created.data;
  await tutor.call('tutor_import', 'POST', `/api/tutor/exams/${examId}/import`, {
    subject: args.subject,
    count: args.questions,
  });
  await tutor.call('tutor_publish', 'POST', `/api/tutor/exams/${examId}/publish`, {});
  return { tutor, examId };
}

async function virtualUser(index, args, examId, recorder, keepRunning) {
  const think = () => sleep(args.think * (0.5 + Math.random()));
  const session = new Session(args.url, recorder);
  const email = `student${String(index + 1).padStart(3, '0')}@demo.quiz`;
  if (!(await session.login(email, args.password)).ok) {
    await sleep(2000);
    return;
  }
  await session.call('list_exams', 'GET', '/api/student/exams');
  await think();

  const started = await session.call('start_exam', 'POST', `/api/student/exams/${examId}/start`, {}, [409]);
  if (started.ok && keepRunning()) {
    const { attemptId } = started.data;
    const paper = await session.call('open_paper', 'GET', `/api/student/attempts/${attemptId}`);
    for (const question of paper.data?.questions || []) {
      if (!keepRunning()) break;
      await think();
      await session.call('save_answer', 'PUT', `/api/student/attempts/${attemptId}/answers/${question.id}`, {
        selectedOption: Math.floor(Math.random() * question.options.length),
      });
    }
    await session.call('submit_exam', 'POST', `/api/student/attempts/${attemptId}/submit`, {});
  }

  while (keepRunning()) {
    await think();
    await session.call('list_exams', 'GET', '/api/student/exams');
    await think();
    await session.call('list_results', 'GET', '/api/student/results');
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const recorder = new Recorder();
  const { tutor, examId } = await prepareExam(args, recorder);

  const startedAt = new Date();
  const testStart = Date.now();
  const totalSeconds = args.stages.reduce((sum, stage) => sum + stage.seconds, 0);
  const running = new Map();

  const targetUsers = () => {
    let elapsed = (Date.now() - testStart) / 1000;
    for (const stage of args.stages) {
      if (elapsed < stage.seconds) return stage.users;
      elapsed -= stage.seconds;
    }
    return 0;
  };

  while ((Date.now() - testStart) / 1000 < totalSeconds) {
    const target = targetUsers();
    for (let index = 0; index < target; index += 1) {
      if (!running.has(index)) {
        const task = virtualUser(index, args, examId, recorder, () => index < targetUsers())
          .catch(() => {})
          .finally(() => running.delete(index));
        running.set(index, task);
      }
    }
    await sleep(500);
  }
  await Promise.race([Promise.all(running.values()), sleep(20000)]);
  const endedAt = new Date();
  await tutor.call('tutor_close', 'POST', `/api/tutor/exams/${examId}/close`, {});

  const all = [];
  const totals = { ok: 0, expected: 0, clientErrors: 0, serverErrors: 0, networkErrors: 0 };
  const endpoints = {};
  for (const [name, endpoint] of [...recorder.endpoints].sort()) {
    all.push(...endpoint.latencies);
    for (const key of Object.keys(totals)) totals[key] += endpoint[key];
    endpoints[name] = {
      requests: endpoint.latencies.length,
      ok: endpoint.ok,
      expected: endpoint.expected,
      clientErrors: endpoint.clientErrors,
      serverErrors: endpoint.serverErrors,
      networkErrors: endpoint.networkErrors,
      ...describe(endpoint.latencies),
    };
  }

  const failures = totals.serverErrors + totals.networkErrors;
  const durationSeconds = (endedAt - startedAt) / 1000;
  const result = {
    url: args.url,
    stages: args.stages,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationSeconds,
    totals: {
      requests: all.length,
      requestsPerSecond: Math.round((all.length / durationSeconds) * 10) / 10,
      ...totals,
      failurePercent: all.length ? Math.round((failures / all.length) * 10000) / 100 : 0,
      ...describe(all),
    },
    endpoints,
    timeline: [...recorder.buckets].sort((a, b) => a[0] - b[0]).map(([second, bucket]) => ({
      second,
      requests: bucket.latencies.length,
      failures: bucket.failures,
      ...describe(bucket.latencies),
    })),
  };

  if (args.out) {
    fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
    fs.writeFileSync(args.out, `${JSON.stringify(result, null, 2)}\n`);
  }
  const { requests, requestsPerSecond, failurePercent, p50Ms, p95Ms, p99Ms } = result.totals;
  console.log(`${requests} requests, ${requestsPerSecond}/s, ${failurePercent}% failed, p50 ${p50Ms} ms, p95 ${p95Ms} ms, p99 ${p99Ms} ms`);
}

main().catch((error) => {
  console.error(`Load test failed: ${error.message}`);
  process.exit(1);
});
