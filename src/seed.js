'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { hashPassword, newLinkCode } = require('./lib/auth');
const log = require('./lib/logger');

const BANK_PATH = path.join(__dirname, '..', 'dataset', 'question_bank.csv');
const OPTION_LETTERS = ['A', 'B', 'C', 'D'];

function parseCsv(content) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (quoted) {
      if (char === '"' && content[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') field += char;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }

  const [header, ...records] = rows;
  return records.map((record) => Object.fromEntries(header.map((name, index) => [name, record[index]])));
}

function loadQuestionBank() {
  return parseCsv(fs.readFileSync(BANK_PATH, 'utf8')).map((row) => ({
    subject: row.subject,
    difficulty: row.difficulty,
    prompt: row.prompt,
    options: [row.option_a, row.option_b, row.option_c, row.option_d],
    correctOption: OPTION_LETTERS.indexOf(row.correct_option),
    explanation: row.explanation,
  }));
}

async function count(connection, table) {
  const [[row]] = await connection.query(`SELECT COUNT(*) AS total FROM ${table}`);
  return Number(row.total);
}

async function createUser(connection, { name, email, role, password, linkCode = null }) {
  const passwordHash = await hashPassword(password);
  const [result] = await connection.query(
    'INSERT INTO users (name, email, password_hash, role, link_code) VALUES (?, ?, ?, ?, ?)',
    [name, email, passwordHash, role, linkCode],
  );
  return result.insertId;
}

async function seedQuestionBank(connection) {
  if ((await count(connection, 'question_bank')) > 0) return 0;
  const bank = loadQuestionBank();
  for (const item of bank) {
    await connection.query(
      `INSERT INTO question_bank (subject, difficulty, prompt, options_json, correct_option, explanation)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [item.subject, item.difficulty, item.prompt, JSON.stringify(item.options), item.correctOption, item.explanation],
    );
  }
  return bank.length;
}

async function seedDemoUsers(connection, config) {
  if (!config.demoPassword || (await count(connection, 'users')) > 0) return 0;

  const password = config.demoPassword;
  const tutorId = await createUser(connection, { name: 'Demo Tutor', email: 'tutor@demo.quiz', role: 'tutor', password });
  const parentId = await createUser(connection, { name: 'Demo Parent', email: 'parent@demo.quiz', role: 'parent', password });

  let firstStudentId = null;
  for (let number = 1; number <= config.demoStudents; number += 1) {
    const label = String(number).padStart(3, '0');
    const studentId = await createUser(connection, {
      name: `Student ${label}`,
      email: `student${label}@demo.quiz`,
      role: 'student',
      password,
      linkCode: newLinkCode(),
    });
    firstStudentId = firstStudentId || studentId;
  }
  await connection.query('INSERT INTO parent_student (parent_id, student_id) VALUES (?, ?)', [parentId, firstStudentId]);

  const [exam] = await connection.query(
    `INSERT INTO exams (tutor_id, title, subject, description, duration_minutes, pass_percent, status)
     VALUES (?, ?, ?, ?, ?, ?, 'published')`,
    [tutorId, 'Cloud Computing Basics', 'Cloud Computing', 'Eight questions on core cloud concepts.', 15, 40],
  );
  const [picks] = await connection.query(
    `SELECT prompt, options_json, correct_option FROM question_bank
     WHERE subject = 'Cloud Computing' ORDER BY id LIMIT 7`,
  );
  let position = 1;
  for (const pick of picks) {
    await connection.query(
      `INSERT INTO questions (exam_id, type, prompt, options_json, correct_option, marks, sort_order)
       VALUES (?, 'mcq', ?, ?, ?, 1, ?)`,
      [exam.insertId, pick.prompt, pick.options_json, pick.correct_option, position],
    );
    position += 1;
  }
  await connection.query(
    `INSERT INTO questions (exam_id, type, prompt, marks, sort_order) VALUES (?, 'short', ?, 3, ?)`,
    [exam.insertId, 'Explain in two or three sentences why an Auto Scaling group is placed across two Availability Zones.', position],
  );
  return config.demoStudents + 2;
}

async function seedDatabase(connection, config) {
  const questions = await seedQuestionBank(connection);
  const users = await seedDemoUsers(connection, config);
  if (questions || users) log.info('database_seeded', { questions, users });
}

module.exports = { seedDatabase, parseCsv, loadQuestionBank };
