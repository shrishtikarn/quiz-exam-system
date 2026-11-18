'use strict';

const express = require('express');
const { query, queryOne, withTransaction } = require('../db');
const { HttpError, wrap, toId, integer, optionalText } = require('../lib/http');
const { finalizeAttempt } = require('../lib/grading');
const { resultsForStudent, resultDetail } = require('../lib/results');
const { toSql, fromSql, isoFromSql } = require('../lib/time');
const log = require('../lib/logger');

async function finalize(attemptId, reason) {
  const { attempt, finalized } = await withTransaction((connection) => finalizeAttempt(connection, attemptId));
  if (finalized) {
    log.info('exam_submitted', { attemptId, examId: attempt.exam_id, reason, status: attempt.status });
  }
  return attempt;
}

async function ownAttempt(attemptId, studentId) {
  const attempt = await queryOne('SELECT * FROM attempts WHERE id = ? AND student_id = ?', [attemptId, studentId]);
  if (!attempt) throw new HttpError(404, 'Attempt not found');
  return attempt;
}

function isExpired(attempt) {
  return attempt.status === 'in_progress' && fromSql(attempt.deadline_at).getTime() <= Date.now();
}

function studentRoutes(config, auth) {
  const router = express.Router();
  router.use(auth.requireRole('student'));

  router.get('/exams', wrap(async (req, res) => {
    const expired = await query(
      `SELECT id FROM attempts WHERE student_id = ? AND status = 'in_progress' AND deadline_at <= ?`,
      [req.user.id, toSql(new Date())],
    );
    for (const { id } of expired) await finalize(id, 'deadline');

    const rows = await query(
      `SELECT e.id, e.title, e.subject, e.description, e.duration_minutes, e.status, e.results_released,
              t.name AS tutor_name,
              (SELECT COUNT(*) FROM questions q WHERE q.exam_id = e.id) AS question_count,
              (SELECT COALESCE(SUM(q.marks), 0) FROM questions q WHERE q.exam_id = e.id) AS total_marks,
              a.id AS attempt_id, a.status AS attempt_status
       FROM exams e
       JOIN users t ON t.id = e.tutor_id
       LEFT JOIN attempts a ON a.exam_id = e.id AND a.student_id = ?
       WHERE e.status = 'published' OR a.id IS NOT NULL
       ORDER BY e.created_at DESC, e.id DESC
       LIMIT 100`,
      [req.user.id],
    );

    res.json({
      exams: rows.map((row) => ({
        id: row.id,
        title: row.title,
        subject: row.subject,
        description: row.description,
        durationMinutes: row.duration_minutes,
        status: row.status,
        resultsReleased: Boolean(row.results_released),
        tutorName: row.tutor_name,
        questionCount: Number(row.question_count),
        totalMarks: Number(row.total_marks),
        attemptId: row.attempt_id,
        attemptStatus: row.attempt_status,
      })),
    });
  }));

  router.post('/exams/:id/start', wrap(async (req, res) => {
    const examId = toId(req.params.id, 'exam');
    const exam = await queryOne(`SELECT * FROM exams WHERE id = ?`, [examId]);
    if (!exam) throw new HttpError(404, 'Exam not found');

    const existing = await queryOne('SELECT * FROM attempts WHERE exam_id = ? AND student_id = ?', [examId, req.user.id]);
    if (existing) {
      if (existing.status === 'in_progress' && !isExpired(existing)) {
        return res.json({ attemptId: existing.id });
      }
      if (isExpired(existing)) await finalize(existing.id, 'deadline');
      throw new HttpError(409, 'You have already taken this exam');
    }
    if (exam.status !== 'published') throw new HttpError(409, 'This exam is not open');

    const now = new Date();
    const deadline = new Date(now.getTime() + exam.duration_minutes * 60 * 1000);
    await query(
      `INSERT IGNORE INTO attempts (exam_id, student_id, status, started_at, deadline_at)
       VALUES (?, ?, 'in_progress', ?, ?)`,
      [examId, req.user.id, toSql(now), toSql(deadline)],
    );
    // A double click can race; the unique key keeps one attempt and both requests read it back.
    const attempt = await queryOne('SELECT id FROM attempts WHERE exam_id = ? AND student_id = ?', [examId, req.user.id]);
    log.info('exam_started', { examId, attemptId: attempt.id });
    return res.status(201).json({ attemptId: attempt.id });
  }));

  router.get('/attempts/:id', wrap(async (req, res) => {
    const attemptId = toId(req.params.id, 'attempt');
    let attempt = await ownAttempt(attemptId, req.user.id);
    if (isExpired(attempt)) attempt = await finalize(attemptId, 'deadline');

    const exam = await queryOne('SELECT id, title, subject, duration_minutes FROM exams WHERE id = ?', [attempt.exam_id]);
    if (attempt.status !== 'in_progress') {
      return res.json({ attemptId, status: attempt.status, exam: { id: exam.id, title: exam.title } });
    }

    // The answer key column is deliberately not selected here.
    const questions = await query(
      `SELECT id, type, prompt, options_json, marks FROM questions WHERE exam_id = ? ORDER BY sort_order, id`,
      [attempt.exam_id],
    );
    const answers = await query(
      'SELECT question_id, selected_option, answer_text FROM answers WHERE attempt_id = ?',
      [attemptId],
    );

    return res.json({
      attemptId,
      status: attempt.status,
      startedAt: isoFromSql(attempt.started_at),
      deadlineAt: isoFromSql(attempt.deadline_at),
      remainingSeconds: Math.max(0, Math.floor((fromSql(attempt.deadline_at).getTime() - Date.now()) / 1000)),
      exam: { id: exam.id, title: exam.title, subject: exam.subject, durationMinutes: exam.duration_minutes },
      questions: questions.map((question) => ({
        id: question.id,
        type: question.type,
        prompt: question.prompt,
        options: question.options_json ? JSON.parse(question.options_json) : null,
        marks: question.marks,
      })),
      answers: answers.map((answer) => ({
        questionId: answer.question_id,
        selectedOption: answer.selected_option,
        answerText: answer.answer_text,
      })),
    });
  }));

  router.put('/attempts/:id/answers/:questionId', wrap(async (req, res) => {
    const attemptId = toId(req.params.id, 'attempt');
    const questionId = toId(req.params.questionId, 'question');
    const attempt = await ownAttempt(attemptId, req.user.id);
    if (attempt.status !== 'in_progress') throw new HttpError(409, 'This attempt has been submitted');

    const graceMs = config.answerGraceSeconds * 1000;
    if (fromSql(attempt.deadline_at).getTime() + graceMs <= Date.now()) {
      await finalize(attemptId, 'deadline');
      throw new HttpError(409, 'Time is up for this exam');
    }

    const question = await queryOne('SELECT id, type, options_json FROM questions WHERE id = ? AND exam_id = ?', [
      questionId,
      attempt.exam_id,
    ]);
    if (!question) throw new HttpError(404, 'Question not found');

    let selectedOption = null;
    let answerText = null;
    if (question.type === 'mcq') {
      if (req.body.selectedOption !== null && req.body.selectedOption !== undefined) {
        const lastOption = JSON.parse(question.options_json).length - 1;
        selectedOption = integer(req.body.selectedOption, 'Selected option', { min: 0, max: lastOption });
      }
    } else {
      answerText = optionalText(req.body.answerText, 'Answer', 5000);
    }

    await query(
      `INSERT INTO answers (attempt_id, question_id, selected_option, answer_text)
       VALUES (?, ?, ?, ?) AS new
       ON DUPLICATE KEY UPDATE selected_option = new.selected_option, answer_text = new.answer_text`,
      [attemptId, questionId, selectedOption, answerText],
    );
    res.json({ saved: true });
  }));

  router.post('/attempts/:id/submit', wrap(async (req, res) => {
    const attemptId = toId(req.params.id, 'attempt');
    await ownAttempt(attemptId, req.user.id);
    const attempt = await finalize(attemptId, 'student');
    res.json({ attemptId, status: attempt.status });
  }));

  router.get('/results', wrap(async (req, res) => {
    res.json({ results: await resultsForStudent(req.user.id) });
  }));

  router.get('/results/:attemptId', wrap(async (req, res) => {
    const attemptId = toId(req.params.attemptId, 'attempt');
    res.json({ result: await resultDetail(attemptId, 'a.student_id = ?', [req.user.id]) });
  }));

  return router;
}

module.exports = { studentRoutes };
