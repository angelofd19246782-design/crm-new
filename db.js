// Uses the built-in node:sqlite module (Node.js 22+) — no native compilation required.
const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');
const path   = require('path');

const db = new DatabaseSync(path.join(__dirname, 'crm.db'));

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    username    TEXT UNIQUE NOT NULL,
    password    TEXT NOT NULL,
    role        TEXT NOT NULL CHECK(role IN ('admin', 'employee')),
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS applications (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    source               TEXT,
    external_id          TEXT UNIQUE,
    name                 TEXT NOT NULL,
    phone                TEXT,
    email                TEXT,
    comment              TEXT,
    status               TEXT NOT NULL DEFAULT 'new'
                           CHECK(status IN ('new','in_progress','completed','incomplete')),
    assigned_employee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    queue_number         INTEGER,
    created_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
    deleted_at           DATETIME
  );

  CREATE TABLE IF NOT EXISTS attachments (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    file_name      TEXT NOT NULL,
    file_path      TEXT NOT NULL,
    mime_type      TEXT,
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS notes (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content        TEXT NOT NULL,
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sessions (
    sid     TEXT PRIMARY KEY,
    data    TEXT NOT NULL,
    expires INTEGER NOT NULL
  );
`);

// Seed a default admin account if none exists
const adminExists = db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
if (!adminExists) {
  const hash = bcrypt.hashSync('admin123', 10);
  db.prepare("INSERT INTO users (username, password, role) VALUES ('admin', ?, 'admin')").run(hash);
  console.log('Default admin created  →  username: admin  |  password: admin123');
  console.log('Change the password after first login!');
}

// Seed demo data only when the applications table is empty
const hasApps = Number(db.prepare('SELECT COUNT(*) AS n FROM applications').get().n) > 0;
if (!hasApps) {
  // Demo employee
  const empR = db.prepare("INSERT INTO users (username, password, role) VALUES ('demo_employee', ?, 'employee')")
    .run(bcrypt.hashSync('employee123', 10));
  const empId = Number(empR.lastInsertRowid);
  console.log('Demo employee created  →  username: demo_employee  |  password: employee123');

  const insApp = db.prepare(`
    INSERT INTO applications (source, name, phone, email, comment, status, assigned_employee_id, queue_number, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const apps = [
    ['web_form',  'Alice Johnson',  '+1 555 010 1111', 'alice@example.com',   'Need help with account setup and initial configuration.',        'new',         null,  1, '2026-04-14 09:12:00'],
    ['web_form',  'Bob Martinez',   '+1 555 020 2222', 'bob@example.com',     'Requesting a quote for enterprise plan upgrade.',                'in_progress', empId, 2, '2026-04-15 11:34:00'],
    ['bot',       'Carol Williams', '+1 555 030 3333', null,                  'Issue with payment processing — transaction declined twice.',     'in_progress', empId, 3, '2026-04-15 14:05:00'],
    ['web_form',  'David Lee',      '+1 555 040 4444', 'david@example.com',   'Onboarding completed successfully. Everything is working.',       'completed',   empId, 4, '2026-04-16 08:47:00'],
    ['bot',       'Eva Müller',     '+1 555 050 5555', 'eva@example.com',     'Could not upload document — got a 413 error from the portal.',   'incomplete',  null,  5, '2026-04-17 16:22:00'],
  ];

  for (const a of apps) insApp.run(...a);
  console.log('Demo applications seeded (5 records).');
}

module.exports = db;
