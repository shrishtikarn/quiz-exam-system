'use strict';

const { query, queryOne } = require('../db');
const { percent } = require('./grading');
const { isoFromSql } = require('./time');
const { HttpError } = require('./http');

function summarise(row) {
  const score = row.auto_score + row.manual_score;
  const scorePercent = percent(score, row.max_score);
  return {
    attemptId: row.attempt_id,
    examId: row.exam_id,
    examTitle: row.title,
    subject: row.subject,
    studentId: row.student_id,
    studentName: row.student_name,
    score,
    maxScore: row.max_score,
    percent: scorePercent,
    passPercent: row.pass_percent,
    passed: scorePercent >= row.pass_percent,
    submittedAt: isoFromSql(row.submitted_at),
  };
}

const RESULT_SELECT = `
  SELECT a.id AS attempt_id, a.exam_id, a.student_id, a.auto_score, a.manual_score, a.max_score,
         a.submitted_at, e.title, e.subject, e.pass_percent, s.name AS student_name
  FROM attempts a
  JOIN exams e ON e.id = a.exam_id
  JOIN users s ON s.id = a.student_id`;

const RELEASED = `e.results_released = 1 AND a.status = 'evaluated'`;

async function resultsForStudent(studentId) {
  const rows = await query(
    `${RESULT_SELECT} WHERE a.student_id = ? AND ${RELEASED} ORDER BY a.submitted_at DESC LIMIT 200`,
    [studentId],
  );
  return rows.map(summarise);
}

async function resultsForParent(parentId) {
  const rows = await query(
    `${RESULT_SELECT}
     JOIN parent_student ps ON ps.student_id = a.student_id
     WHERE ps.parent_id = ? AND ${RELEASED}
     ORDER BY a.submitted_at DESC LIMIT 200`,
    [parentId],
  );
  return rows.map(summarise);
}

/** Returns a released result with its answers. The caller supplies who may read it. */
async function resultDetail(attemptId, accessSql, accessParams) {
  const row = await queryOne(
    `${RESULT_SELECT} WHERE a.id = ? AND ${RELEASED} AND ${accessSql}`,
    [attemptId, ...accessParams],
  );
  if (!row) throw new HttpError(404, 'Result not found or not released yet');

  const answers = await query(
    `SELECT q.id AS question_id, q.type, q.prompt, q.options_json, q.correct_option, q.marks,
            ans.selected_option, ans.answer_text, ans.marks_awarded, ans.feedback
     FROM questions q
     LEFT JOIN answers ans ON ans.question_id = q.id AND ans.attempt_id = ?
     WHERE q.exam_id = ?
     ORDER BY q.sort_order, q.id`,
    [attemptId, row.exam_id],
  );

  return {
    ...summarise(row),
    answers: answers.map((answer) => ({
      questionId: answer.question_id,
      type: answer.type,
      prompt: answer.prompt,
      options: answer.options_json ? JSON.parse(answer.options_json) : null,
      correctOption: answer.correct_option,
      selectedOption: answer.selected_option,
      answerText: answer.answer_text,
      marks: answer.marks,
      marksAwarded: answer.marks_awarded ?? 0,
      feedback: answer.feedback,
    })),
  };
}

module.exports = { resultsForStudent, resultsForParent, resultDetail };
