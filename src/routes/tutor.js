'use strict';

const express = require('express');
const { query, queryOne, withTransaction } = require('../db');
const { HttpError, wrap, toId, text, optionalText, integer } = require('../lib/http');
const { finalizeAttempt, percent } = require('../lib/grading');
const { toSql, isoFromSql } = require('../lib/time');
const log = require('../lib/logger');

async function ownExam(examId, tutorId) {
  const exam = await queryOne('SELECT * FROM exams WHERE id = ? AND tutor_id = ?', [examId, tutorId]);
  if (!exam) throw new HttpError(404, 'Exam not found');
  return exam;
}

function requireDraft(exam) {
  if (exam.status !== 'draft') throw new HttpError(409, 'Published exams cannot be edited');
}

function examSummary(row) {
  return {
    id: row.id,
    title: row.title,
    subject: row.subject,
    description: row.description,
    durationMinutes: row.duration_minutes,
    passPercent: row.pass_percent,
    status: row.status,
    resultsReleased: Boolean(row.results_released),
    createdAt: isoFromSql(row.created_at),
  };
}

function parseExamBody(body) {
  return {
    title: text(body.title, 'Title', { max: 160 }),
    subject: text(body.subject, 'Subject', { max: 80 }),
    description: optionalText(body.description, 'Description'),
    durationMinutes: integer(body.durationMinutes, 'Duration', { min: 1, max: 300 }),
    passPercent: integer(body.passPercent ?? 40, 'Pass mark', { min: 0, max: 100 }),
  };
}

function parseQuestionBody(body) {
  const type = body.type;
  if (type !== 'mcq' && type !== 'short') throw new HttpError(400, 'Question type must be mcq or short');
  const prompt = text(body.prompt, 'Question', { max: 2000 });
  const marks = integer(body.marks ?? 1, 'Marks', { min: 1, max: 100 });
  if (type === 'short') return { type, prompt, marks, optionsJson: null, correctOption: null };

  if (!Array.isArray(body.options) || body.options.length < 2 || body.options.length > 6) {
    throw new HttpError(400, 'Multiple-choice questions need 2 to 6 options');
  }
  const options = body.options.map((option, index) => text(option, `Option ${index + 1}`, { max: 500 }));
  const correctOption = integer(body.correctOption, 'Correct option', { min: 0, max: options.length - 1 });
  return { type, prompt, marks, optionsJson: JSON.stringify(options), correctOption };
}

async function nextPosition(executor, examId) {
  const rows = await executor('SELECT COALESCE(MAX(sort_order), 0) AS last_position FROM questions WHERE exam_id = ?', [examId]);
  return Number(rows[0].last_position) + 1;
}

function tutorRoutes(auth) {
  const router = express.Router();
  router.use(auth.requireRole('tutor'));

  router.get('/bank/subjects', wrap(async (_req, res) => {
    const rows = await query('SELECT subject, COUNT(*) AS total FROM question_bank GROUP BY subject ORDER BY subject');
    res.json({ subjects: rows.map((row) => ({ subject: row.subject, total: Number(row.total) })) });
  }));

  router.get('/exams', wrap(async (req, res) => {
    const rows = await query(
      `SELECT e.*,
              (SELECT COUNT(*) FROM questions q WHERE q.exam_id = e.id) AS question_count,
              (SELECT COUNT(*) FROM attempts a WHERE a.exam_id = e.id AND a.status <> 'in_progress') AS submitted_count,
              (SELECT COUNT(*) FROM attempts a WHERE a.exam_id = e.id AND a.status = 'submitted') AS pending_count
       FROM exams e
       WHERE e.tutor_id = ?
       ORDER BY e.created_at DESC, e.id DESC`,
      [req.user.id],
    );
    res.json({
      exams: rows.map((row) => ({
        ...examSummary(row),
        questionCount: Number(row.question_count),
        submittedCount: Number(row.submitted_count),
        pendingCount: Number(row.pending_count),
      })),
    });
  }));

  router.post('/exams', wrap(async (req, res) => {
    const exam = parseExamBody(req.body);
    const result = await query(
      `INSERT INTO exams (tutor_id, title, subject, description, duration_minutes, pass_percent)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [req.user.id, exam.title, exam.subject, exam.description, exam.durationMinutes, exam.passPercent],
    );
    log.info('exam_created', { examId: result.insertId, tutorId: req.user.id });
    res.status(201).json({ examId: result.insertId });
  }));

  router.get('/exams/:id', wrap(async (req, res) => {
    const exam = await ownExam(toId(req.params.id, 'exam'), req.user.id);
    const questions = await query('SELECT * FROM questions WHERE exam_id = ? ORDER BY sort_order, id', [exam.id]);
    res.json({
      exam: examSummary(exam),
      questions: questions.map((question) => ({
        id: question.id,
        type: question.type,
        prompt: question.prompt,
        options: question.options_json ? JSON.parse(question.options_json) : null,
        correctOption: question.correct_option,
        marks: question.marks,
      })),
    });
  }));

  router.put('/exams/:id', wrap(async (req, res) => {
    const current = await ownExam(toId(req.params.id, 'exam'), req.user.id);
    requireDraft(current);
    const exam = parseExamBody(req.body);
    await query(
      `UPDATE exams SET title = ?, subject = ?, description = ?, duration_minutes = ?, pass_percent = ? WHERE id = ?`,
      [exam.title, exam.subject, exam.description, exam.durationMinutes, exam.passPercent, current.id],
    );
    res.json({ saved: true });
  }));

  router.post('/exams/:id/questions', wrap(async (req, res) => {
    const exam = await ownExam(toId(req.params.id, 'exam'), req.user.id);
    requireDraft(exam);
    const question = parseQuestionBody(req.body);
    const position = await nextPosition(query, exam.id);
    const result = await query(
      `INSERT INTO questions (exam_id, type, prompt, options_json, correct_option, marks, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [exam.id, question.type, question.prompt, question.optionsJson, question.correctOption, question.marks, position],
    );
    res.status(201).json({ questionId: result.insertId });
  }));

  router.delete('/exams/:id/questions/:questionId', wrap(async (req, res) => {
    const exam = await ownExam(toId(req.params.id, 'exam'), req.user.id);
    requireDraft(exam);
    await query('DELETE FROM questions WHERE id = ? AND exam_id = ?', [toId(req.params.questionId, 'question'), exam.id]);
    res.status(204).end();
  }));

  router.post('/exams/:id/import', wrap(async (req, res) => {
    const exam = await ownExam(toId(req.params.id, 'exam'), req.user.id);
    requireDraft(exam);
    const subject = text(req.body.subject, 'Subject', { max: 80 });
    const count = integer(req.body.count, 'Number of questions', { min: 1, max: 50 });
    const marks = integer(req.body.marks ?? 1, 'Marks', { min: 1, max: 100 });

    const picks = await query(
      `SELECT prompt, options_json, correct_option
       FROM question_bank WHERE subject = ? ORDER BY RAND() LIMIT ?`,
      [subject, count],
    );
    if (picks.length === 0) throw new HttpError(404, 'No questions found for that subject');

    await withTransaction(async (connection) => {
      const executor = async (sql, params) => (await connection.query(sql, params))[0];
      let position = await nextPosition(executor, exam.id);
      for (const pick of picks) {
        await connection.query(
          `INSERT INTO questions (exam_id, type, prompt, options_json, correct_option, marks, sort_order)
           VALUES (?, 'mcq', ?, ?, ?, ?, ?)`,
          [exam.id, pick.prompt, pick.options_json, pick.correct_option, marks, position],
        );
        position += 1;
      }
    });
    res.status(201).json({ imported: picks.length });
  }));

  router.post('/exams/:id/publish', wrap(async (req, res) => {
    const exam = await ownExam(toId(req.params.id, 'exam'), req.user.id);
    requireDraft(exam);
    const { total } = await queryOne('SELECT COUNT(*) AS total FROM questions WHERE exam_id = ?', [exam.id]);
    if (Number(total) === 0) throw new HttpError(409, 'Add at least one question before publishing');
    await query(`UPDATE exams SET status = 'published' WHERE id = ?`, [exam.id]);
    log.info('exam_published', { examId: exam.id });
    res.json({ status: 'published' });
  }));

  router.post('/exams/:id/close', wrap(async (req, res) => {
    const exam = await ownExam(toId(req.params.id, 'exam'), req.user.id);
    if (exam.status !== 'published') throw new HttpError(409, 'Only published exams can be closed');
    await query(`UPDATE exams SET status = 'closed' WHERE id = ?`, [exam.id]);
    const open = await query(`SELECT id FROM attempts WHERE exam_id = ? AND status = 'in_progress'`, [exam.id]);
    for (const { id } of open) {
      await withTransaction((connection) => finalizeAttempt(connection, id));
    }
    log.info('exam_closed', { examId: exam.id, autoSubmitted: open.length });
    res.json({ status: 'closed', autoSubmitted: open.length });
  }));

  router.post('/exams/:id/release', wrap(async (req, res) => {
    const exam = await ownExam(toId(req.params.id, 'exam'), req.user.id);
    if (exam.status !== 'closed') throw new HttpError(409, 'Close the exam before releasing results');
    const { pending } = await queryOne(
      `SELECT COUNT(*) AS pending FROM attempts WHERE exam_id = ? AND status <> 'evaluated'`,
      [exam.id],
    );
    if (Number(pending) > 0) throw new HttpError(409, `${pending} submission(s) still need marking`);
    await query('UPDATE exams SET results_released = 1 WHERE id = ?', [exam.id]);
    log.info('results_released', { examId: exam.id });
    res.json({ resultsReleased: true });
  }));

  router.get('/exams/:id/attempts', wrap(async (req, res) => {
    const exam = await ownExam(toId(req.params.id, 'exam'), req.user.id);
    const rows = await query(
      `SELECT a.*, s.name AS student_name, s.email AS student_email
       FROM attempts a JOIN users s ON s.id = a.student_id
       WHERE a.exam_id = ?
       ORDER BY s.name`,
      [exam.id],
    );
    const attempts = rows.map((row) => {
      const score = row.auto_score + row.manual_score;
      return {
        id: row.id,
        studentName: row.student_name,
        studentEmail: row.student_email,
        status: row.status,
        submittedAt: isoFromSql(row.submitted_at),
        score,
        maxScore: row.max_score,
        percent: percent(score, row.max_score),
      };
    });
    const marked = attempts.filter((attempt) => attempt.status === 'evaluated');
    const passed = marked.filter((attempt) => attempt.percent >= exam.pass_percent);
    res.json({
      exam: examSummary(exam),
      attempts,
      summary: {
        submitted: attempts.filter((attempt) => attempt.status !== 'in_progress').length,
        marked: marked.length,
        averagePercent: marked.length
          ? Math.round((marked.reduce((sum, attempt) => sum + attempt.percent, 0) / marked.length) * 10) / 10
          : null,
        passRatePercent: marked.length ? Math.round((passed.length / marked.length) * 1000) / 10 : null,
      },
    });
  }));

  async function ownAttempt(attemptId, tutorId) {
    const attempt = await queryOne(
      `SELECT a.*, e.title, e.results_released, s.name AS student_name
       FROM attempts a
       JOIN exams e ON e.id = a.exam_id
       JOIN users s ON s.id = a.student_id
       WHERE a.id = ? AND e.tutor_id = ?`,
      [attemptId, tutorId],
    );
    if (!attempt) throw new HttpError(404, 'Submission not found');
    return attempt;
  }

  router.get('/attempts/:id', wrap(async (req, res) => {
    const attempt = await ownAttempt(toId(req.params.id, 'attempt'), req.user.id);
    const answers = await query(
      `SELECT q.id AS question_id, q.type, q.prompt, q.options_json, q.correct_option, q.marks,
              ans.selected_option, ans.answer_text, ans.marks_awarded, ans.feedback
       FROM questions q
       LEFT JOIN answers ans ON ans.question_id = q.id AND ans.attempt_id = ?
       WHERE q.exam_id = ?
       ORDER BY q.sort_order, q.id`,
      [attempt.id, attempt.exam_id],
    );
    res.json({
      attempt: {
        id: attempt.id,
        examId: attempt.exam_id,
        examTitle: attempt.title,
        studentName: attempt.student_name,
        status: attempt.status,
        resultsReleased: Boolean(attempt.results_released),
        score: attempt.auto_score + attempt.manual_score,
        maxScore: attempt.max_score,
      },
      answers: answers.map((answer) => ({
        questionId: answer.question_id,
        type: answer.type,
        prompt: answer.prompt,
        options: answer.options_json ? JSON.parse(answer.options_json) : null,
        correctOption: answer.correct_option,
        selectedOption: answer.selected_option,
        answerText: answer.answer_text,
        marks: answer.marks,
        marksAwarded: answer.marks_awarded,
        feedback: answer.feedback,
      })),
    });
  }));

  router.post('/attempts/:id/evaluate', wrap(async (req, res) => {
    const attemptId = toId(req.params.id, 'attempt');
    const attempt = await ownAttempt(attemptId, req.user.id);
    if (attempt.status === 'in_progress') throw new HttpError(409, 'The student has not submitted yet');
    if (attempt.results_released) throw new HttpError(409, 'Results have already been released');
    if (!Array.isArray(req.body.grades) || req.body.grades.length === 0) throw new HttpError(400, 'No marks were sent');

    const status = await withTransaction(async (connection) => {
      await connection.query('SELECT id FROM attempts WHERE id = ? FOR UPDATE', [attemptId]);
      const [questions] = await connection.query(
        `SELECT id, marks FROM questions WHERE exam_id = ? AND type = 'short'`,
        [attempt.exam_id],
      );
      const marksByQuestion = new Map(questions.map((question) => [question.id, question.marks]));
      const now = toSql(new Date());

      for (const grade of req.body.grades) {
        const questionId = toId(grade.questionId, 'question');
        if (!marksByQuestion.has(questionId)) throw new HttpError(400, 'Only short answers can be marked by hand');
        const marks = integer(grade.marks, 'Marks', { min: 0, max: marksByQuestion.get(questionId) });
        const feedback = optionalText(grade.feedback, 'Feedback');
        await connection.query(
          `UPDATE answers SET marks_awarded = ?, feedback = ?, evaluated_by = ?, evaluated_at = ?
           WHERE attempt_id = ? AND question_id = ?`,
          [marks, feedback, req.user.id, now, attemptId, questionId],
        );
      }

      const [answers] = await connection.query(
        `SELECT ans.marks_awarded
         FROM answers ans JOIN questions q ON q.id = ans.question_id
         WHERE ans.attempt_id = ? AND q.type = 'short'`,
        [attemptId],
      );
      const manualScore = answers.reduce((sum, answer) => sum + (answer.marks_awarded || 0), 0);
      const nextStatus = answers.some((answer) => answer.marks_awarded === null) ? 'submitted' : 'evaluated';
      await connection.query('UPDATE attempts SET manual_score = ?, status = ? WHERE id = ?', [
        manualScore,
        nextStatus,
        attemptId,
      ]);
      return nextStatus;
    });

    log.info('attempt_evaluated', { attemptId, status, tutorId: req.user.id });
    res.json({ status });
  }));

  return router;
}

module.exports = { tutorRoutes };
