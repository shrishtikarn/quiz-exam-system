'use strict';

const express = require('express');
const { query, queryOne } = require('../db');
const { HttpError, wrap, toId, text } = require('../lib/http');
const { resultsForParent, resultDetail } = require('../lib/results');
const { FixedWindowLimiter } = require('../lib/ratelimit');
const log = require('../lib/logger');

function parentRoutes(auth) {
  const router = express.Router();
  const failedLinks = new FixedWindowLimiter({ limit: 10, windowMs: 15 * 60 * 1000 });
  router.use(auth.requireRole('parent'));

  router.get('/children', wrap(async (req, res) => {
    const children = await query(
      `SELECT s.id, s.name
       FROM parent_student ps
       JOIN users s ON s.id = ps.student_id
       WHERE ps.parent_id = ?
       ORDER BY s.name`,
      [req.user.id],
    );
    res.json({ children });
  }));

  router.post('/children', wrap(async (req, res) => {
    const key = String(req.user.id);
    if (failedLinks.isBlocked(key)) throw new HttpError(429, 'Too many incorrect codes. Try again later.');

    const linkCode = text(req.body.linkCode, 'Link code', { max: 10 }).toUpperCase();
    const student = await queryOne(`SELECT id, name FROM users WHERE link_code = ? AND role = 'student'`, [linkCode]);
    if (!student) {
      failedLinks.hit(key);
      throw new HttpError(404, 'No student matches that code');
    }

    await query('INSERT IGNORE INTO parent_student (parent_id, student_id) VALUES (?, ?)', [req.user.id, student.id]);
    log.info('parent_linked', { parentId: req.user.id, studentId: student.id });
    res.status(201).json({ child: student });
  }));

  router.get('/results', wrap(async (req, res) => {
    res.json({ results: await resultsForParent(req.user.id) });
  }));

  router.get('/results/:attemptId', wrap(async (req, res) => {
    const attemptId = toId(req.params.attemptId, 'attempt');
    const access = `EXISTS (SELECT 1 FROM parent_student ps WHERE ps.student_id = a.student_id AND ps.parent_id = ?)`;
    res.json({ result: await resultDetail(attemptId, access, [req.user.id]) });
  }));

  return router;
}

module.exports = { parentRoutes };
