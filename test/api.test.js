'use strict';

/*
 * End-to-end API test. It needs a MySQL database, supplied through
 * DB_HOST, DB_USER, DB_PASSWORD and DB_NAME. The CI pipeline starts one as a service.
 */
const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-secret-with-enough-length';
process.env.SEED_ON_BOOT = 'true';
process.env.DEMO_PASSWORD = 'demo-password-1';
process.env.DEMO_STUDENTS = '3';
process.env.LOGIN_MAX_FAILURES = '3';

const { loadConfig } = require('../src/config');
const { initPool, closePool, query } = require('../src/db');
const { createApp } = require('../src/app');
const { prepareDatabase } = require('../src/migrate');

let server;
let baseUrl;
const unique = Date.now().toString(36);

class Client {
  constructor() {
    this.cookie = '';
  }

  async request(method, path, body) {
    const headers = {};
    if (this.cookie) headers.cookie = this.cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0];
    const raw = await response.text();
    let data = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      data = raw;
    }
    return { status: response.status, data, headers: response.headers };
  }

  get(path) { return this.request('GET', path); }
  post(path, body = {}) { return this.request('POST', path, body); }
  put(path, body) { return this.request('PUT', path, body); }
  delete(path) { return this.request('DELETE', path); }
}

async function login(email, password = process.env.DEMO_PASSWORD) {
  const client = new Client();
  const response = await client.post('/api/auth/login', { email, password });
  assert.equal(response.status, 200, `login failed for ${email}`);
  client.user = response.data.user;
  return client;
}

async function register(role, label) {
  const client = new Client();
  const response = await client.post('/api/auth/register', {
    name: `${label} ${unique}`,
    email: `${label}.${unique}@example.com`,
    password: 'correct-horse-1',
    role,
  });
  assert.equal(response.status, 201);
  client.user = response.data.user;
  return client;
}

async function createExam(tutor, overrides = {}) {
  const created = await tutor.post('/api/tutor/exams', {
    title: `Exam ${unique}`,
    subject: 'Testing',
    durationMinutes: 10,
    passPercent: 50,
    ...overrides,
  });
  assert.equal(created.status, 201);
  const examId = created.data.examId;
  const mcq = await tutor.post(`/api/tutor/exams/${examId}/questions`, {
    type: 'mcq', prompt: 'Pick B', options: ['A', 'B', 'C'], correctOption: 1, marks: 2,
  });
  const short = await tutor.post(`/api/tutor/exams/${examId}/questions`, {
    type: 'short', prompt: 'Explain scaling', marks: 3,
  });
  assert.equal(mcq.status, 201);
  assert.equal(short.status, 201);
  return { examId, mcqId: mcq.data.questionId, shortId: short.data.questionId };
}

before(async () => {
  const config = loadConfig();
  initPool(config.db);
  await prepareDatabase(config);
  // A second run must change nothing.
  await prepareDatabase(config);
  await new Promise((resolve) => {
    server = createApp(config, { ready: true }).listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await closePool();
});

test('health endpoints and security headers respond', async () => {
  const client = new Client();
  const health = await client.get('/health');
  assert.equal(health.status, 200);
  assert.equal(health.data.status, 'ok');
  assert.equal((await client.get('/health/db')).status, 200);
  assert.match(health.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(health.headers.get('x-powered-by'), null);
});

test('the question bank dataset and demo users are seeded once', async () => {
  const [{ total }] = await query('SELECT COUNT(*) AS total FROM question_bank');
  assert.equal(Number(total), 60);
  const tutors = await query(`SELECT id FROM users WHERE email = 'tutor@demo.quiz'`);
  assert.equal(tutors.length, 1);
});

test('registration validates input, hides secrets and blocks tutor self-registration', async () => {
  const client = new Client();
  const tutor = await client.post('/api/auth/register', {
    name: 'Fake', email: `fake.${unique}@example.com`, password: 'long-enough-1', role: 'tutor',
  });
  assert.equal(tutor.status, 400);
  const weak = await client.post('/api/auth/register', {
    name: 'Weak', email: `weak.${unique}@example.com`, password: 'short', role: 'student',
  });
  assert.equal(weak.status, 400);

  const student = await register('student', 'register');
  assert.equal(student.user.password_hash, undefined);
  assert.match(student.user.linkCode, /^[A-Z2-9]{10}$/);
  assert.match(student.cookie, /^quiz_session=/);

  const duplicate = await new Client().post('/api/auth/register', {
    name: 'Again', email: `register.${unique}@example.com`, password: 'correct-horse-1', role: 'student',
  });
  assert.equal(duplicate.status, 409);
});

test('session cookie is HttpOnly and SameSite=Strict', async () => {
  const response = await new Client().post('/api/auth/login', {
    email: 'tutor@demo.quiz', password: process.env.DEMO_PASSWORD,
  });
  const cookie = response.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
});

test('repeated failed logins are blocked', async () => {
  const client = new Client();
  const email = 'student003@demo.quiz';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal((await client.post('/api/auth/login', { email, password: 'wrong-password' })).status, 401);
  }
  assert.equal((await client.post('/api/auth/login', { email, password: process.env.DEMO_PASSWORD })).status, 429);
});

test('roles cannot reach each other\'s APIs and non-JSON writes are refused', async () => {
  const student = await login('student001@demo.quiz');
  const parent = await login('parent@demo.quiz');
  const tutor = await login('tutor@demo.quiz');
  assert.equal((await new Client().get('/api/student/exams')).status, 401);
  assert.equal((await student.get('/api/tutor/exams')).status, 403);
  assert.equal((await parent.get('/api/student/exams')).status, 403);
  assert.equal((await tutor.get('/api/parent/results')).status, 403);

  const forged = await fetch(`${baseUrl}/api/tutor/exams`, {
    method: 'POST',
    headers: { cookie: tutor.cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: 'title=x',
  });
  assert.equal(forged.status, 415);
});

test('a tampered session token is rejected', async () => {
  const student = await login('student001@demo.quiz');
  const [name, token] = student.cookie.split('=');
  const [header, , signature] = token.split('.');
  const payload = Buffer.from(JSON.stringify({ sub: '1', role: 'tutor', name: 'x' })).toString('base64url');
  student.cookie = `${name}=${header}.${payload}.${signature}`;
  assert.equal((await student.get('/api/tutor/exams')).status, 401);
});

test('full exam journey for tutor, student and parent', async () => {
  const tutor = await login('tutor@demo.quiz');
  const student = await register('student', 'journey-student');
  const otherStudent = await register('student', 'journey-other');
  const parent = await register('parent', 'journey-parent');
  const strangerParent = await register('parent', 'journey-stranger');
  const { examId, mcqId, shortId } = await createExam(tutor, { title: `Journey ${unique}` });

  // Drafts are invisible and cannot be started.
  const draftList = await student.get('/api/student/exams');
  assert.equal(draftList.data.exams.some((exam) => exam.id === examId), false);
  assert.equal((await student.post(`/api/student/exams/${examId}/start`)).status, 409);

  assert.equal((await tutor.post(`/api/tutor/exams/${examId}/publish`)).status, 200);
  assert.equal((await tutor.post(`/api/tutor/exams/${examId}/questions`, { type: 'short', prompt: 'Late' })).status, 409);

  const started = await student.post(`/api/student/exams/${examId}/start`);
  assert.equal(started.status, 201);
  const { attemptId } = started.data;
  assert.equal((await student.post(`/api/student/exams/${examId}/start`)).data.attemptId, attemptId);

  // The answer key must never reach a student during the exam.
  const paper = await student.get(`/api/student/attempts/${attemptId}`);
  assert.equal(paper.status, 200);
  assert.equal(JSON.stringify(paper.data).includes('correctOption'), false);
  assert.equal(JSON.stringify(paper.data).includes('correct_option'), false);
  assert.ok(paper.data.remainingSeconds > 500);

  // Another student cannot read or answer this attempt.
  assert.equal((await otherStudent.get(`/api/student/attempts/${attemptId}`)).status, 404);
  assert.equal((await otherStudent.put(`/api/student/attempts/${attemptId}/answers/${mcqId}`, { selectedOption: 1 })).status, 404);

  assert.equal((await student.put(`/api/student/attempts/${attemptId}/answers/${mcqId}`, { selectedOption: 9 })).status, 400);
  assert.equal((await student.put(`/api/student/attempts/${attemptId}/answers/${mcqId}`, { selectedOption: 0 })).status, 200);
  assert.equal((await student.put(`/api/student/attempts/${attemptId}/answers/${mcqId}`, { selectedOption: 1 })).status, 200);
  assert.equal((await student.put(`/api/student/attempts/${attemptId}/answers/${shortId}`, { answerText: 'Add instances.' })).status, 200);

  const resumed = await student.get(`/api/student/attempts/${attemptId}`);
  assert.equal(resumed.data.answers.find((answer) => answer.questionId === mcqId).selectedOption, 1);

  const submitted = await student.post(`/api/student/attempts/${attemptId}/submit`);
  assert.equal(submitted.data.status, 'submitted');
  assert.equal((await student.put(`/api/student/attempts/${attemptId}/answers/${mcqId}`, { selectedOption: 0 })).status, 409);
  assert.equal((await student.post(`/api/student/exams/${examId}/start`)).status, 409);

  // Other student starts but never submits; closing hands the paper in.
  const otherAttempt = (await otherStudent.post(`/api/student/exams/${examId}/start`)).data.attemptId;
  await otherStudent.put(`/api/student/attempts/${otherAttempt}/answers/${mcqId}`, { selectedOption: 0 });
  const closed = await tutor.post(`/api/tutor/exams/${examId}/close`);
  assert.equal(closed.data.autoSubmitted, 1);
  assert.equal((await new Client().get('/health')).status, 200);

  // Results stay hidden until marking is complete and the tutor releases them.
  assert.equal((await tutor.post(`/api/tutor/exams/${examId}/release`)).status, 409);
  assert.equal((await student.get(`/api/student/results/${attemptId}`)).status, 404);

  const review = await tutor.get(`/api/tutor/attempts/${attemptId}`);
  assert.equal(review.data.attempt.score, 2);
  assert.equal((await tutor.post(`/api/tutor/attempts/${attemptId}/evaluate`, {
    grades: [{ questionId: shortId, marks: 9 }],
  })).status, 400);
  assert.equal((await tutor.post(`/api/tutor/attempts/${attemptId}/evaluate`, {
    grades: [{ questionId: mcqId, marks: 1 }],
  })).status, 400);
  const evaluated = await tutor.post(`/api/tutor/attempts/${attemptId}/evaluate`, {
    grades: [{ questionId: shortId, marks: 2, feedback: 'Mention both directions.' }],
  });
  assert.equal(evaluated.data.status, 'evaluated');

  const summary = await tutor.get(`/api/tutor/exams/${examId}/attempts`);
  assert.equal(summary.data.summary.submitted, 2);
  assert.equal(summary.data.summary.marked, 2);
  assert.equal(summary.data.summary.averagePercent, 40);
  assert.equal(summary.data.summary.passRatePercent, 50);

  assert.equal((await tutor.post(`/api/tutor/exams/${examId}/release`)).status, 200);
  assert.equal((await tutor.post(`/api/tutor/attempts/${attemptId}/evaluate`, {
    grades: [{ questionId: shortId, marks: 3 }],
  })).status, 409);

  const results = await student.get('/api/student/results');
  const result = results.data.results.find((item) => item.attemptId === attemptId);
  assert.equal(result.score, 4);
  assert.equal(result.maxScore, 5);
  assert.equal(result.percent, 80);
  assert.equal(result.passed, true);

  const detail = await student.get(`/api/student/results/${attemptId}`);
  assert.equal(detail.data.result.answers.find((answer) => answer.questionId === shortId).feedback, 'Mention both directions.');

  // Parents see only children linked with the private code.
  assert.equal((await parent.post('/api/parent/children', { linkCode: 'WRONGCODE2' })).status, 404);
  assert.equal((await parent.get(`/api/parent/results/${attemptId}`)).status, 404);
  assert.equal((await parent.post('/api/parent/children', { linkCode: student.user.linkCode })).status, 201);
  const parentResults = await parent.get('/api/parent/results');
  assert.deepEqual(parentResults.data.results.map((item) => item.attemptId), [attemptId]);
  assert.equal((await parent.get(`/api/parent/results/${attemptId}`)).data.result.score, 4);
  assert.equal((await strangerParent.get(`/api/parent/results/${attemptId}`)).status, 404);
  assert.deepEqual((await strangerParent.get('/api/parent/results')).data.results, []);
});

test('tutors cannot see or change another tutor\'s exams', async () => {
  const tutor = await login('tutor@demo.quiz');
  const { examId } = await createExam(tutor, { title: `Owned ${unique}` });
  const hash = (await query(`SELECT password_hash FROM users WHERE email = 'tutor@demo.quiz'`))[0].password_hash;
  const email = `tutor2.${unique}@example.com`;
  await query(`INSERT INTO users (name, email, password_hash, role) VALUES ('Second Tutor', ?, ?, 'tutor')`, [email, hash]);
  const other = await login(email);
  assert.equal((await other.get(`/api/tutor/exams/${examId}`)).status, 404);
  assert.equal((await other.post(`/api/tutor/exams/${examId}/publish`)).status, 404);
  assert.equal((await other.get(`/api/tutor/exams/${examId}/attempts`)).status, 404);
});

test('an expired attempt is submitted with its saved answers and rejects new ones', async () => {
  const tutor = await login('tutor@demo.quiz');
  const student = await register('student', 'expiry');
  const { examId, mcqId } = await createExam(tutor, { title: `Expiry ${unique}` });
  await tutor.post(`/api/tutor/exams/${examId}/publish`);
  const { attemptId } = (await student.post(`/api/student/exams/${examId}/start`)).data;
  await student.put(`/api/student/attempts/${attemptId}/answers/${mcqId}`, { selectedOption: 1 });
  await query(`UPDATE attempts SET deadline_at = '2020-01-01 00:00:00' WHERE id = ?`, [attemptId]);

  assert.equal((await student.put(`/api/student/attempts/${attemptId}/answers/${mcqId}`, { selectedOption: 0 })).status, 409);
  const after = await student.get(`/api/student/attempts/${attemptId}`);
  assert.equal(after.data.status, 'evaluated');
  const [row] = await query('SELECT auto_score, max_score FROM attempts WHERE id = ?', [attemptId]);
  assert.equal(row.auto_score, 2);
  assert.equal(row.max_score, 5);
});

test('tutors can import questions from the bank', async () => {
  const tutor = await login('tutor@demo.quiz');
  const { examId } = (await tutor.post('/api/tutor/exams', {
    title: `Import ${unique}`, subject: 'DBMS', durationMinutes: 5, passPercent: 40,
  })).data;
  const subjects = await tutor.get('/api/tutor/bank/subjects');
  assert.equal(subjects.data.subjects.length, 5);
  const imported = await tutor.post(`/api/tutor/exams/${examId}/import`, { subject: 'DBMS', count: 5, marks: 2 });
  assert.equal(imported.data.imported, 5);
  const exam = await tutor.get(`/api/tutor/exams/${examId}`);
  assert.equal(exam.data.questions.length, 5);
  assert.ok(exam.data.questions.every((question) => question.marks === 2 && question.options.length === 4));
});
