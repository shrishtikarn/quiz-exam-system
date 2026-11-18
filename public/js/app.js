'use strict';

/* All text is added with textContent through h(), so user input is never parsed as HTML. */
const root = document.getElementById('app');
const nav = document.getElementById('nav');
const toastBox = document.getElementById('toast');
let currentUser = null;
let stopView = null;

function h(tag, attrs = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') element.className = value;
    else if (key.startsWith('on')) element.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'value') element.value = value;
    else if (key === 'checked' || key === 'disabled' || key === 'required' || key === 'selected') element[key] = Boolean(value);
    else element.setAttribute(key, value);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return element;
}

async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || 'The request failed');
    error.status = response.status;
    throw error;
  }
  return data;
}

let toastTimer = null;
function toast(message) {
  toastBox.textContent = message;
  toastBox.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastBox.classList.remove('show'), 3000);
}

function show(...nodes) {
  root.className = 'page';
  root.replaceChildren(...nodes.flat().filter(Boolean));
  window.scrollTo(0, 0);
}

function go(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

function field(label, control) {
  return h('label', {}, label, control);
}

function formValues(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function submitForm(handler) {
  return async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button[type="submit"]');
    const errorBox = form.querySelector('.error');
    if (errorBox) errorBox.textContent = '';
    if (button) button.disabled = true;
    try {
      await handler(formValues(form), form);
    } catch (error) {
      if (errorBox) errorBox.textContent = error.message;
      else toast(error.message);
    } finally {
      if (button) button.disabled = false;
    }
  };
}

function action(handler) {
  return async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await handler();
    } catch (error) {
      toast(error.message);
    } finally {
      button.disabled = false;
    }
  };
}

function formatDate(value) {
  return value ? new Date(value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '';
}

function badge(label, tone = '') {
  return h('span', { class: `badge ${tone}` }, label);
}

function table(headers, rows, empty) {
  if (rows.length === 0) return h('p', { class: 'muted' }, empty);
  return h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, headers.map((header) => h('th', { scope: 'col', class: header.num ? 'num' : '' }, header.label)))),
    h('tbody', {}, rows.map((cells) => h('tr', {}, cells.map((cell, index) => h('td', { class: headers[index].num ? 'num' : '' }, cell))))),
  ));
}

function renderNav() {
  nav.replaceChildren();
  if (!currentUser) return;
  nav.append(
    h('span', {}, `${currentUser.name} · ${currentUser.role}`),
    h('button', { class: 'link', type: 'button', onClick: logout }, 'Log out'),
  );
}

async function logout() {
  await api('/auth/logout', { method: 'POST' });
  currentUser = null;
  renderNav();
  go('#/');
}

/* ---------- Sign in ---------- */

function authView(mode = 'login') {
  const isLogin = mode === 'login';
  const form = h('form', { class: 'stack', onSubmit: submitForm(async (values) => {
    const data = await api(isLogin ? '/auth/login' : '/auth/register', { method: 'POST', body: values });
    currentUser = data.user;
    renderNav();
    go('#/');
    route();
  }) },
    !isLogin && field('Full name', h('input', { name: 'name', required: true, autocomplete: 'name' })),
    field('Email', h('input', { name: 'email', type: 'email', required: true, autocomplete: 'email' })),
    field('Password', h('input', {
      name: 'password', type: 'password', required: true, minlength: isLogin ? undefined : 8,
      autocomplete: isLogin ? 'current-password' : 'new-password',
    })),
    !isLogin && field('I am a', h('select', { name: 'role' },
      h('option', { value: 'student' }, 'Student'),
      h('option', { value: 'parent' }, 'Parent'),
    )),
    h('p', { class: 'error', role: 'alert' }),
    h('button', { type: 'submit' }, isLogin ? 'Log in' : 'Create account'),
  );

  show(h('div', { class: 'stack' },
    h('div', { class: 'stack tight' },
      h('h1', {}, isLogin ? 'Log in' : 'Create your account'),
      h('p', { class: 'muted' }, 'Take exams, follow results and mark papers in one place.'),
    ),
    h('div', { class: 'card' }, form),
    h('p', { class: 'small muted' }, isLogin ? 'New here? ' : 'Already registered? ',
      h('button', { class: 'link', type: 'button', onClick: () => authView(isLogin ? 'register' : 'login') },
        isLogin ? 'Create an account' : 'Log in')),
  ));
  root.classList.add('narrow');
}

/* ---------- Shared result view ---------- */

function resultSummaryRows(results, base, withStudent) {
  return results.map((result) => [
    ...(withStudent ? [result.studentName] : []),
    h('a', { href: `#/${base}/result/${result.attemptId}` }, result.examTitle),
    result.subject,
    `${result.score} / ${result.maxScore}`,
    `${result.percent}%`,
    badge(result.passed ? 'Passed' : 'Below pass mark', result.passed ? 'good' : 'bad'),
  ]);
}

function resultHeaders(withStudent) {
  return [
    ...(withStudent ? [{ label: 'Student' }] : []),
    { label: 'Exam' }, { label: 'Subject' }, { label: 'Score', num: true }, { label: 'Percent', num: true }, { label: 'Outcome' },
  ];
}

function answerReview(answer, index) {
  const body = answer.type === 'mcq'
    ? h('div', { class: 'options' }, answer.options.map((option, optionIndex) => {
      const isCorrect = optionIndex === answer.correctOption;
      const isChosen = optionIndex === answer.selectedOption;
      return h('div', { class: `option ${isCorrect ? 'correct' : isChosen ? 'wrong' : ''}` },
        h('span', {}, option, isCorrect ? ' (correct answer)' : '', isChosen ? ' (selected)' : ''));
    }))
    : h('p', { class: 'pre-wrap' }, answer.answerText || 'No answer given');
  return h('div', { class: 'card' },
    h('div', { class: 'row between' },
      h('h3', {}, `Question ${index + 1}`),
      badge(`${answer.marksAwarded ?? 0} / ${answer.marks} marks`, 'accent')),
    h('p', { class: 'pre-wrap' }, answer.prompt),
    body,
    answer.feedback && h('p', { class: 'notice' }, `Tutor feedback: ${answer.feedback}`),
  );
}

async function resultView(base) {
  const attemptId = location.hash.split('/').pop();
  const { result } = await api(`/${base}/results/${attemptId}`);
  show(h('div', { class: 'stack' },
    h('a', { href: '#/', class: 'small' }, 'Back to dashboard'),
    h('h1', {}, result.examTitle),
    h('p', { class: 'muted' }, `${result.studentName} · ${result.subject} · submitted ${formatDate(result.submittedAt)}`),
    h('div', { class: 'stats' },
      stat(`${result.score} / ${result.maxScore}`, 'Score'),
      stat(`${result.percent}%`, 'Percent'),
      stat(`${result.passPercent}%`, 'Pass mark'),
      stat(result.passed ? 'Passed' : 'Not passed', 'Outcome'),
    ),
    result.answers.map(answerReview),
  ));
}

function stat(value, label) {
  return h('div', { class: 'stat' }, h('strong', {}, value), h('span', { class: 'small muted' }, label));
}

/* ---------- Student ---------- */

function studentExamAction(exam) {
  if (exam.attemptStatus === 'in_progress') {
    return h('button', { type: 'button', onClick: () => go(`#/student/attempt/${exam.attemptId}`) }, 'Resume exam');
  }
  if (exam.attemptStatus === 'submitted') return badge('Awaiting marking', 'warn');
  if (exam.attemptStatus === 'evaluated') {
    return exam.resultsReleased ? badge('Result released', 'good') : badge('Marked, result not released', 'warn');
  }
  return h('button', { type: 'button', onClick: action(async () => {
    const { attemptId } = await api(`/student/exams/${exam.id}/start`, { method: 'POST' });
    go(`#/student/attempt/${attemptId}`);
  }) }, 'Start exam');
}

async function studentHome() {
  const [{ exams }, { results }, { user }] = await Promise.all([
    api('/student/exams'), api('/student/results'), api('/auth/me'),
  ]);
  show(
    h('div', { class: 'stack' },
      h('h1', {}, `Hello, ${user.name}`),
      h('p', { class: 'muted' }, 'Share this code with a parent so they can follow your results: ',
        h('span', { class: 'code' }, user.linkCode)),
    ),
    h('section', { class: 'section' },
      h('h2', {}, 'Exams'),
      exams.length === 0 && h('p', { class: 'muted' }, 'No exams are open right now.'),
      exams.map((exam) => h('div', { class: 'card' },
        h('div', { class: 'row between' },
          h('div', { class: 'stack tight' },
            h('h3', {}, exam.title),
            h('p', { class: 'small muted' },
              `${exam.subject} · ${exam.questionCount} questions · ${exam.totalMarks} marks · ${exam.durationMinutes} minutes · ${exam.tutorName}`),
          ),
          studentExamAction(exam),
        ),
        exam.description && h('p', {}, exam.description),
      )),
    ),
    h('section', { class: 'section' },
      h('h2', {}, 'Results'),
      table(resultHeaders(false), resultSummaryRows(results, 'student', false), 'Results appear here after your tutor releases them.'),
    ),
  );
}

async function attemptView() {
  const attemptId = location.hash.split('/').pop();
  const attempt = await api(`/student/attempts/${attemptId}`);
  if (attempt.status !== 'in_progress') {
    show(h('div', { class: 'stack' },
      h('h1', {}, 'Exam submitted'),
      h('p', { class: 'notice' }, `${attempt.exam.title} has been handed in. Your result appears after your tutor releases it.`),
      h('a', { href: '#/' }, 'Back to dashboard'),
    ));
    return;
  }

  const saved = new Map(attempt.answers.map((answer) => [answer.questionId, answer]));
  const status = h('span', { class: 'small muted', role: 'status' }, 'All answers saved');
  const timer = h('span', { class: 'timer', role: 'timer' });
  const pending = new Map();
  let submitted = false;
  let failedSaves = 0;

  async function save(questionId, body) {
    status.textContent = 'Saving…';
    try {
      await api(`/student/attempts/${attemptId}/answers/${questionId}`, { method: 'PUT', body });
      failedSaves = 0;
      if (pending.size === 0) status.textContent = 'All answers saved';
    } catch (error) {
      failedSaves += 1;
      status.textContent = `Not saved: ${error.message}`;
      if (error.status === 409) finish();
    }
  }

  function queueText(questionId, value) {
    clearTimeout(pending.get(questionId));
    status.textContent = 'Saving…';
    pending.set(questionId, setTimeout(() => {
      pending.delete(questionId);
      save(questionId, { answerText: value });
    }, 500));
  }

  async function flush() {
    const inputs = root.querySelectorAll('textarea[data-question]');
    const saves = [];
    for (const input of inputs) {
      const questionId = Number(input.dataset.question);
      if (pending.has(questionId)) {
        clearTimeout(pending.get(questionId));
        pending.delete(questionId);
        saves.push(save(questionId, { answerText: input.value }));
      }
    }
    await Promise.all(saves);
  }

  async function finish() {
    if (submitted) return;
    submitted = true;
    clearInterval(clock);
    await flush().catch(() => {});
    try {
      await api(`/student/attempts/${attemptId}/submit`, { method: 'POST' });
    } catch (error) {
      if (error.status !== 409) {
        submitted = false;
        toast(error.message);
        return;
      }
    }
    route();
  }

  const deadline = Date.now() + attempt.remainingSeconds * 1000;
  function tick() {
    const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
    const minutes = String(Math.floor(left / 60)).padStart(2, '0');
    const seconds = String(left % 60).padStart(2, '0');
    timer.textContent = `${minutes}:${seconds}`;
    timer.classList.toggle('low', left <= 60);
    if (left === 0) finish();
  }
  const clock = setInterval(tick, 1000);
  stopView = () => clearInterval(clock);
  tick();

  show(h('div', { class: 'stack' },
    h('div', { class: 'stack tight' },
      h('h1', {}, attempt.exam.title),
      h('p', { class: 'muted' }, `${attempt.exam.subject} · ${attempt.questions.length} questions`),
    ),
    h('div', { class: 'exam-bar' }, timer, status),
    attempt.questions.map((question, index) => {
      const answer = saved.get(question.id) || {};
      const body = question.type === 'mcq'
        ? h('div', { class: 'options', role: 'radiogroup', 'aria-label': `Question ${index + 1}` },
          question.options.map((option, optionIndex) => h('label', { class: 'option' },
            h('input', {
              type: 'radio', name: `q${question.id}`, value: optionIndex,
              checked: answer.selectedOption === optionIndex,
              onChange: () => save(question.id, { selectedOption: optionIndex }),
            }),
            h('span', {}, option))))
        : field('Your answer', h('textarea', {
          'data-question': question.id,
          maxlength: 5000,
          value: answer.answerText || '',
          onInput: (event) => queueText(question.id, event.target.value),
        }));
      return h('div', { class: 'card' },
        h('div', { class: 'row between' },
          h('h2', {}, `Question ${index + 1}`),
          badge(`${question.marks} ${question.marks === 1 ? 'mark' : 'marks'}`)),
        h('p', { class: 'pre-wrap' }, question.prompt),
        body,
      );
    }),
    h('div', { class: 'row' }, h('button', { type: 'button', onClick: () => {
      if (window.confirm('Submit this exam? You cannot change your answers afterwards.')) finish();
    } }, 'Submit exam')),
  ));
}

/* ---------- Parent ---------- */

async function parentHome() {
  const [{ children }, { results }] = await Promise.all([api('/parent/children'), api('/parent/results')]);
  show(
    h('h1', {}, 'Your children’s results'),
    h('section', { class: 'section' },
      h('h2', {}, 'Linked children'),
      h('p', {}, children.length ? children.map((child) => child.name).join(', ') : 'No children are linked yet.'),
      h('form', { class: 'card', onSubmit: submitForm(async (values, form) => {
        const { child } = await api('/parent/children', { method: 'POST', body: values });
        form.reset();
        toast(`${child.name} linked`);
        route();
      }) },
        field('Student link code', h('input', { name: 'linkCode', required: true, maxlength: 10, autocomplete: 'off' })),
        h('p', { class: 'small muted' }, 'The student can find this code on their dashboard.'),
        h('p', { class: 'error', role: 'alert' }),
        h('div', { class: 'row' }, h('button', { type: 'submit' }, 'Link child')),
      ),
    ),
    h('section', { class: 'section' },
      h('h2', {}, 'Released results'),
      table(resultHeaders(true), resultSummaryRows(results, 'parent', true), 'Results appear here after a tutor releases them.'),
    ),
  );
}

/* ---------- Tutor ---------- */

function examStatusBadge(exam) {
  if (exam.resultsReleased) return badge('Results released', 'good');
  if (exam.status === 'published') return badge('Open', 'accent');
  if (exam.status === 'closed') return badge('Closed', 'warn');
  return badge('Draft');
}

function examFields() {
  return [
    field('Title', h('input', { name: 'title', required: true, maxlength: 160 })),
    h('div', { class: 'grid-3' },
      field('Subject', h('input', { name: 'subject', required: true, maxlength: 80 })),
      field('Duration (minutes)', h('input', { name: 'durationMinutes', type: 'number', min: 1, max: 300, value: 30, required: true })),
      field('Pass mark (%)', h('input', { name: 'passPercent', type: 'number', min: 0, max: 100, value: 40, required: true })),
    ),
    field('Instructions (optional)', h('textarea', { name: 'description', maxlength: 2000 })),
  ];
}

async function tutorHome() {
  const { exams } = await api('/tutor/exams');
  show(
    h('h1', {}, 'Your exams'),
    h('section', { class: 'section' },
      table(
        [{ label: 'Exam' }, { label: 'Status' }, { label: 'Questions', num: true }, { label: 'Submitted', num: true }, { label: 'To mark', num: true }],
        exams.map((exam) => [
          h('a', { href: `#/tutor/exam/${exam.id}` }, exam.title),
          examStatusBadge(exam),
          exam.questionCount, exam.submittedCount, exam.pendingCount,
        ]),
        'You have not created an exam yet.',
      ),
    ),
    h('section', { class: 'section' },
      h('h2', {}, 'Create an exam'),
      h('form', { class: 'card', onSubmit: submitForm(async (values) => {
        const { examId } = await api('/tutor/exams', { method: 'POST', body: values });
        go(`#/tutor/exam/${examId}`);
      }) }, examFields(), h('p', { class: 'error', role: 'alert' }), h('div', { class: 'row' }, h('button', { type: 'submit' }, 'Create exam'))),
    ),
  );
}

function questionForm(examId) {
  const optionInputs = [0, 1, 2, 3].map((index) => field(`Option ${index + 1}`, h('input', { name: `option${index}`, maxlength: 500 })));
  const mcqFields = h('div', { class: 'stack' },
    h('div', { class: 'grid-2' }, optionInputs),
    field('Correct option', h('select', { name: 'correctOption' }, [0, 1, 2, 3].map((index) => h('option', { value: index }, `Option ${index + 1}`)))),
  );
  const typeSelect = h('select', { name: 'type', onChange: (event) => { mcqFields.hidden = event.target.value !== 'mcq'; } },
    h('option', { value: 'mcq' }, 'Multiple choice (marked automatically)'),
    h('option', { value: 'short' }, 'Short answer (marked by you)'),
  );
  return h('form', { class: 'card', onSubmit: submitForm(async (values) => {
    const body = { type: values.type, prompt: values.prompt, marks: Number(values.marks) };
    if (values.type === 'mcq') {
      const entered = [0, 1, 2, 3].map((index) => ({ index, text: values[`option${index}`].trim() })).filter((option) => option.text);
      body.options = entered.map((option) => option.text);
      body.correctOption = entered.findIndex((option) => option.index === Number(values.correctOption));
    }
    await api(`/tutor/exams/${examId}/questions`, { method: 'POST', body });
    toast('Question added');
    route();
  }) },
    h('h3', {}, 'Write a question'),
    h('div', { class: 'grid-2' }, field('Type', typeSelect), field('Marks', h('input', { name: 'marks', type: 'number', min: 1, max: 100, value: 1, required: true }))),
    field('Question', h('textarea', { name: 'prompt', required: true, maxlength: 2000 })),
    mcqFields,
    h('p', { class: 'error', role: 'alert' }),
    h('div', { class: 'row' }, h('button', { type: 'submit' }, 'Add question')),
  );
}

function importForm(examId, subjects) {
  if (subjects.length === 0) return null;
  return h('form', { class: 'card', onSubmit: submitForm(async (values) => {
    const { imported } = await api(`/tutor/exams/${examId}/import`, {
      method: 'POST', body: { subject: values.subject, count: Number(values.count), marks: Number(values.marks) },
    });
    toast(`${imported} questions imported`);
    route();
  }) },
    h('h3', {}, 'Import from the question bank'),
    h('div', { class: 'grid-3' },
      field('Subject', h('select', { name: 'subject' }, subjects.map((item) => h('option', { value: item.subject }, `${item.subject} (${item.total})`)))),
      field('Questions', h('input', { name: 'count', type: 'number', min: 1, max: 50, value: 5, required: true })),
      field('Marks each', h('input', { name: 'marks', type: 'number', min: 1, max: 100, value: 1, required: true })),
    ),
    h('p', { class: 'error', role: 'alert' }),
    h('div', { class: 'row' }, h('button', { class: 'secondary', type: 'submit' }, 'Import questions')),
  );
}

function examActions(exam, examId) {
  const post = (path, message) => action(async () => {
    await api(`/tutor/exams/${examId}/${path}`, { method: 'POST' });
    toast(message);
    route();
  });
  if (exam.status === 'draft') return h('button', { type: 'button', onClick: post('publish', 'Exam published') }, 'Publish exam');
  if (exam.status === 'published') return h('button', { class: 'danger', type: 'button', onClick: post('close', 'Exam closed') }, 'Close exam');
  if (!exam.resultsReleased) return h('button', { type: 'button', onClick: post('release', 'Results released') }, 'Release results');
  return null;
}

async function tutorExam() {
  const examId = location.hash.split('/').pop();
  const [{ exam, questions }, submissions, { subjects }] = await Promise.all([
    api(`/tutor/exams/${examId}`), api(`/tutor/exams/${examId}/attempts`), api('/tutor/bank/subjects'),
  ]);
  const totalMarks = questions.reduce((sum, question) => sum + question.marks, 0);
  const { summary, attempts } = submissions;

  show(h('div', { class: 'stack' },
    h('a', { href: '#/', class: 'small' }, 'Back to exams'),
    h('div', { class: 'row between' },
      h('div', { class: 'stack tight' },
        h('div', { class: 'row' }, h('h1', {}, exam.title), examStatusBadge(exam)),
        h('p', { class: 'muted' }, `${exam.subject} · ${exam.durationMinutes} minutes · ${totalMarks} marks · pass mark ${exam.passPercent}%`),
      ),
      examActions(exam, examId),
    ),
    exam.status !== 'draft' && h('div', { class: 'stats' },
      stat(summary.submitted, 'Submitted'),
      stat(summary.marked, 'Marked'),
      stat(summary.averagePercent === null ? '–' : `${summary.averagePercent}%`, 'Average'),
      stat(summary.passRatePercent === null ? '–' : `${summary.passRatePercent}%`, 'Pass rate'),
    ),
    exam.status !== 'draft' && h('section', { class: 'section' },
      h('h2', {}, 'Submissions'),
      table(
        [{ label: 'Student' }, { label: 'Status' }, { label: 'Score', num: true }, { label: 'Percent', num: true }, { label: '' }],
        attempts.map((attempt) => [
          attempt.studentName,
          attempt.status === 'evaluated' ? badge('Marked', 'good') : attempt.status === 'submitted' ? badge('To mark', 'warn') : badge('In progress'),
          attempt.status === 'in_progress' ? '–' : `${attempt.score} / ${attempt.maxScore}`,
          attempt.status === 'in_progress' ? '–' : `${attempt.percent}%`,
          attempt.status !== 'in_progress' && h('a', { href: `#/tutor/attempt/${attempt.id}` }, attempt.status === 'submitted' ? 'Mark' : 'View'),
        ]),
        'Nobody has started this exam yet.',
      ),
    ),
    h('section', { class: 'section' },
      h('h2', {}, `Questions (${questions.length})`),
      questions.length === 0 && h('p', { class: 'muted' }, 'Add questions below, then publish the exam.'),
      questions.map((question, index) => h('div', { class: 'card' },
        h('div', { class: 'row between' },
          h('h3', {}, `Question ${index + 1}`),
          h('div', { class: 'row' },
            badge(question.type === 'mcq' ? 'Multiple choice' : 'Short answer'),
            badge(`${question.marks} marks`, 'accent'),
            exam.status === 'draft' && h('button', { class: 'link', type: 'button', onClick: action(async () => {
              await api(`/tutor/exams/${examId}/questions/${question.id}`, { method: 'DELETE' });
              route();
            }) }, 'Remove'),
          ),
        ),
        h('p', { class: 'pre-wrap' }, question.prompt),
        question.options && h('div', { class: 'options' }, question.options.map((option, optionIndex) => h('div', {
          class: `option ${optionIndex === question.correctOption ? 'correct' : ''}`,
        }, option))),
      )),
    ),
    exam.status === 'draft' && importForm(examId, subjects),
    exam.status === 'draft' && questionForm(examId),
  ));
}

async function tutorAttempt() {
  const attemptId = location.hash.split('/').pop();
  const { attempt, answers } = await api(`/tutor/attempts/${attemptId}`);
  const editable = !attempt.resultsReleased;
  const hasShort = answers.some((answer) => answer.type === 'short');

  const form = h('form', { class: 'stack', onSubmit: submitForm(async (values) => {
    const grades = answers.filter((answer) => answer.type === 'short').map((answer) => ({
      questionId: answer.questionId,
      marks: Number(values[`marks${answer.questionId}`]),
      feedback: values[`feedback${answer.questionId}`],
    }));
    await api(`/tutor/attempts/${attemptId}/evaluate`, { method: 'POST', body: { grades } });
    toast('Marks saved');
    go(`#/tutor/exam/${attempt.examId}`);
  }) },
    answers.map((answer, index) => {
      if (answer.type === 'mcq') return answerReview(answer, index);
      return h('div', { class: 'card' },
        h('div', { class: 'row between' }, h('h3', {}, `Question ${index + 1}`), badge(`Out of ${answer.marks}`, 'accent')),
        h('p', { class: 'pre-wrap' }, answer.prompt),
        h('p', { class: 'notice pre-wrap' }, answer.answerText || 'No answer given'),
        h('div', { class: 'grid-2' },
          field('Marks', h('input', {
            name: `marks${answer.questionId}`, type: 'number', min: 0, max: answer.marks, required: true,
            value: answer.marksAwarded ?? '', disabled: !editable,
          })),
          field('Feedback (optional)', h('input', { name: `feedback${answer.questionId}`, value: answer.feedback || '', disabled: !editable })),
        ),
      );
    }),
    h('p', { class: 'error', role: 'alert' }),
    hasShort && editable && h('div', { class: 'row' }, h('button', { type: 'submit' }, 'Save marks')),
  );

  show(h('div', { class: 'stack' },
    h('a', { href: `#/tutor/exam/${attempt.examId}`, class: 'small' }, 'Back to exam'),
    h('h1', {}, attempt.studentName),
    h('p', { class: 'muted' }, `${attempt.examTitle} · current score ${attempt.score} / ${attempt.maxScore}`),
    form,
  ));
}

/* ---------- Routing ---------- */

const ROUTES = {
  student: [[/^#\/student\/attempt\/\d+$/, attemptView], [/^#\/student\/result\/\d+$/, () => resultView('student')]],
  parent: [[/^#\/parent\/result\/\d+$/, () => resultView('parent')]],
  tutor: [[/^#\/tutor\/exam\/\d+$/, tutorExam], [/^#\/tutor\/attempt\/\d+$/, tutorAttempt]],
};
const HOMES = { student: studentHome, parent: parentHome, tutor: tutorHome };

async function route() {
  if (stopView) {
    stopView();
    stopView = null;
  }
  if (!currentUser) {
    authView();
    return;
  }
  const match = ROUTES[currentUser.role].find(([pattern]) => pattern.test(location.hash));
  const view = match ? match[1] : HOMES[currentUser.role];
  try {
    await view();
  } catch (error) {
    if (error.status === 401) {
      currentUser = null;
      renderNav();
      authView();
      return;
    }
    show(h('div', { class: 'stack' }, h('h1', {}, 'That did not work'), h('p', {}, error.message), h('a', { href: '#/' }, 'Back to dashboard')));
  }
}

async function start() {
  try {
    currentUser = (await api('/auth/me')).user;
  } catch {
    currentUser = null;
  }
  renderNav();
  window.addEventListener('hashchange', route);
  route();
}

start();
