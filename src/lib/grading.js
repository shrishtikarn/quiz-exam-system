'use strict';

const { HttpError } = require('./http');
const { toSql } = require('./time');

/** Grades an attempt and closes it. Safe to call more than once. */
async function finalizeAttempt(connection, attemptId, now = new Date()) {
  const [attemptRows] = await connection.query('SELECT * FROM attempts WHERE id = ? FOR UPDATE', [attemptId]);
  const attempt = attemptRows[0];
  if (!attempt) throw new HttpError(404, 'Attempt not found');
  if (attempt.status !== 'in_progress') return { attempt, finalized: false };

  const [questions] = await connection.query(
    'SELECT id, type, correct_option, marks FROM questions WHERE exam_id = ?',
    [attempt.exam_id],
  );
  const [saved] = await connection.query(
    'SELECT question_id, selected_option, answer_text FROM answers WHERE attempt_id = ?',
    [attemptId],
  );
  const savedByQuestion = new Map(saved.map((row) => [row.question_id, row]));

  let autoScore = 0;
  let maxScore = 0;
  let awaitingTutor = 0;

  for (const question of questions) {
    maxScore += question.marks;
    const answer = savedByQuestion.get(question.id) || {};
    const selected = answer.selected_option ?? null;
    const answerText = answer.answer_text ?? null;
    let marksAwarded = 0;

    if (question.type === 'mcq') {
      if (selected !== null && selected === question.correct_option) marksAwarded = question.marks;
      autoScore += marksAwarded;
    } else if (answerText && answerText.trim()) {
      marksAwarded = null;
      awaitingTutor += 1;
    }

    await connection.query(
      `INSERT INTO answers (attempt_id, question_id, selected_option, answer_text, marks_awarded)
       VALUES (?, ?, ?, ?, ?) AS new
       ON DUPLICATE KEY UPDATE marks_awarded = new.marks_awarded`,
      [attemptId, question.id, selected, answerText, marksAwarded],
    );
  }

  const status = awaitingTutor > 0 ? 'submitted' : 'evaluated';
  await connection.query(
    `UPDATE attempts
     SET status = ?, submitted_at = ?, auto_score = ?, manual_score = 0, max_score = ?
     WHERE id = ?`,
    [status, toSql(now), autoScore, maxScore, attemptId],
  );

  return {
    attempt: { ...attempt, status, auto_score: autoScore, manual_score: 0, max_score: maxScore },
    finalized: true,
  };
}

function percent(score, maxScore) {
  return maxScore > 0 ? Math.round((score / maxScore) * 1000) / 10 : 0;
}

module.exports = { finalizeAttempt, percent };
