CREATE TABLE IF NOT EXISTS users (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  email VARCHAR(190) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('student','parent','tutor') NOT NULL,
  link_code CHAR(10) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_users_email (email),
  UNIQUE KEY uq_users_link_code (link_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS parent_student (
  parent_id INT UNSIGNED NOT NULL,
  student_id INT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (parent_id, student_id),
  KEY idx_parent_student_student (student_id),
  CONSTRAINT fk_ps_parent FOREIGN KEY (parent_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_ps_student FOREIGN KEY (student_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS question_bank (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  subject VARCHAR(80) NOT NULL,
  difficulty ENUM('easy','medium','hard') NOT NULL,
  prompt TEXT NOT NULL,
  options_json TEXT NOT NULL,
  correct_option TINYINT UNSIGNED NOT NULL,
  explanation TEXT NULL,
  KEY idx_bank_subject (subject, difficulty)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS exams (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tutor_id INT UNSIGNED NOT NULL,
  title VARCHAR(160) NOT NULL,
  subject VARCHAR(80) NOT NULL,
  description TEXT NULL,
  duration_minutes INT UNSIGNED NOT NULL,
  pass_percent INT UNSIGNED NOT NULL DEFAULT 40,
  status ENUM('draft','published','closed') NOT NULL DEFAULT 'draft',
  results_released TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_exams_tutor (tutor_id),
  KEY idx_exams_status (status),
  CONSTRAINT fk_exams_tutor FOREIGN KEY (tutor_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS questions (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  exam_id INT UNSIGNED NOT NULL,
  type ENUM('mcq','short') NOT NULL,
  prompt TEXT NOT NULL,
  options_json TEXT NULL,
  correct_option TINYINT UNSIGNED NULL,
  marks INT UNSIGNED NOT NULL DEFAULT 1,
  sort_order INT UNSIGNED NOT NULL DEFAULT 0,
  KEY idx_questions_exam (exam_id, sort_order),
  CONSTRAINT fk_questions_exam FOREIGN KEY (exam_id) REFERENCES exams (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS attempts (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  exam_id INT UNSIGNED NOT NULL,
  student_id INT UNSIGNED NOT NULL,
  status ENUM('in_progress','submitted','evaluated') NOT NULL DEFAULT 'in_progress',
  started_at DATETIME NOT NULL,
  deadline_at DATETIME NOT NULL,
  submitted_at DATETIME NULL,
  auto_score INT UNSIGNED NOT NULL DEFAULT 0,
  manual_score INT UNSIGNED NOT NULL DEFAULT 0,
  max_score INT UNSIGNED NOT NULL DEFAULT 0,
  UNIQUE KEY uq_attempt_exam_student (exam_id, student_id),
  KEY idx_attempts_student (student_id),
  KEY idx_attempts_status (status, deadline_at),
  CONSTRAINT fk_attempts_exam FOREIGN KEY (exam_id) REFERENCES exams (id) ON DELETE CASCADE,
  CONSTRAINT fk_attempts_student FOREIGN KEY (student_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS answers (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  attempt_id INT UNSIGNED NOT NULL,
  question_id INT UNSIGNED NOT NULL,
  selected_option TINYINT UNSIGNED NULL,
  answer_text TEXT NULL,
  marks_awarded INT UNSIGNED NULL,
  feedback TEXT NULL,
  evaluated_by INT UNSIGNED NULL,
  evaluated_at DATETIME NULL,
  UNIQUE KEY uq_answer_attempt_question (attempt_id, question_id),
  KEY idx_answers_question (question_id),
  CONSTRAINT fk_answers_attempt FOREIGN KEY (attempt_id) REFERENCES attempts (id) ON DELETE CASCADE,
  CONSTRAINT fk_answers_question FOREIGN KEY (question_id) REFERENCES questions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
