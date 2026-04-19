require('dotenv').config();
const express  = require('express');
const session  = require('express-session');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const bcrypt   = require('bcryptjs');
const db       = require('./db');

const app       = express();
const PORT      = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_API_TOKEN;
const UPLOADS   = path.join(__dirname, 'uploads');

// Required when running behind Railway's (or any) reverse proxy.
// Without this, express-session's issecure() check returns false even on HTTPS,
// so the Set-Cookie header is silently dropped when cookie.secure = true.
app.set('trust proxy', 1);

if (!fs.existsSync(UPLOADS)) fs.mkdirSync(UPLOADS, { recursive: true });

// ── Session store ─────────────────────────────────────────────────────────────
const SessionStore = require('express-session').Store;

class SQLiteStore extends SessionStore {
  get(sid, cb) {
    try {
      const row = db.prepare('SELECT data, expires FROM sessions WHERE sid = ?').get(sid);
      if (!row || row.expires < Date.now()) return cb(null, null);
      cb(null, JSON.parse(row.data));
    } catch (e) { cb(e); }
  }
  set(sid, sess, cb) {
    try {
      const expires = sess.cookie?.expires
        ? new Date(sess.cookie.expires).getTime()
        : Date.now() + 8 * 60 * 60 * 1000;
      db.prepare('INSERT OR REPLACE INTO sessions (sid, data, expires) VALUES (?, ?, ?)')
        .run(sid, JSON.stringify(sess), expires);
      cb(null);
    } catch (e) { cb(e); }
  }
  destroy(sid, cb) {
    try { db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid); cb(null); }
    catch (e) { cb(e); }
  }
}

setInterval(() => db.exec(`DELETE FROM sessions WHERE expires < ${Date.now()}`), 15 * 60 * 1000);

// ── File upload ───────────────────────────────────────────────────────────────
const ALLOWED_MIMES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
]);

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOADS),
    filename:    (_req, file,  cb) => cb(null, `${Date.now()}-${Math.round(Math.random()*1e9)}${path.extname(file.originalname)}`),
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) =>
    ALLOWED_MIMES.has(file.mimetype) ? cb(null, true) : cb(new Error('File type not allowed')),
});

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  store: new SQLiteStore(),
  secret: process.env.SESSION_SECRET || 'fallback-dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 8 * 60 * 60 * 1000 },
}));
app.use(express.static(path.join(__dirname, 'public')));

// ── Guards ────────────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Unauthorized' });
  next();
}
function requireAdmin(req, res, next) {
  if (!req.session.user || req.session.user.role !== 'admin')
    return res.status(403).json({ error: 'Forbidden' });
  next();
}
function requireBotToken(req, res, next) {
  if (!BOT_TOKEN || req.headers['x-bot-token'] !== BOT_TOKEN)
    return res.status(401).json({ error: 'Invalid bot token' });
  next();
}

// ── Auth ──────────────────────────────────────────────────────────────────────
app.post('/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password))
    return res.status(401).json({ error: 'Invalid credentials' });
  req.session.user = { id: Number(user.id), username: user.username, role: user.role };
  res.json({ role: user.role });
});

app.post('/auth/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));

app.get('/auth/me', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });
  res.json(req.session.user);
});

app.get('/',          (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  return res.redirect(req.session.user.role === 'admin' ? '/admin' : '/employee');
});
app.get('/login',     (_req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/bot',       (_req, res) => res.sendFile(path.join(__dirname, 'public', 'bot.html')));
app.get('/admin',     (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});
app.get('/employee',  (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'public', 'employee.html'));
});

// ── Dashboard stats ───────────────────────────────────────────────────────────
app.get('/api/stats', requireAuth, (req, res) => {
  const total    = Number(db.prepare("SELECT COUNT(*) AS n FROM applications WHERE deleted_at IS NULL").get().n);
  const in_trash = Number(db.prepare("SELECT COUNT(*) AS n FROM applications WHERE deleted_at IS NOT NULL").get().n);
  const rows     = db.prepare("SELECT status, COUNT(*) AS n FROM applications WHERE deleted_at IS NULL GROUP BY status").all();
  const stats    = { total, in_trash, new: 0, in_progress: 0, completed: 0, incomplete: 0 };
  for (const r of rows) stats[r.status] = Number(r.n);
  res.json(stats);
});

// ── Applications ──────────────────────────────────────────────────────────────
app.get('/api/applications', requireAuth, (req, res) => {
  const { status, trash, assigned_to_me } = req.query;
  let sql = `SELECT a.*, u.username AS assigned_username
             FROM applications a LEFT JOIN users u ON a.assigned_employee_id = u.id WHERE 1=1`;
  const p = [];
  sql += trash === '1' ? ' AND a.deleted_at IS NOT NULL' : ' AND a.deleted_at IS NULL';
  if (status)               { sql += ' AND a.status = ?';              p.push(status); }
  if (assigned_to_me === '1') { sql += ' AND a.assigned_employee_id = ?'; p.push(req.session.user.id); }
  sql += ' ORDER BY a.created_at DESC';
  res.json(db.prepare(sql).all(...p));
});

app.get('/api/applications/:id', requireAuth, (req, res) => {
  const rec = db.prepare(`SELECT a.*, u.username AS assigned_username
    FROM applications a LEFT JOIN users u ON a.assigned_employee_id = u.id WHERE a.id = ?`).get(req.params.id);
  if (!rec) return res.status(404).json({ error: 'Not found' });
  res.json(rec);
});

app.post('/api/applications', requireAdmin, (req, res) => {
  const { source, external_id, name, phone, email, comment, status, assigned_employee_id } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name is required' });
  if (name.trim().length > 200)  return res.status(400).json({ error: 'Name too long' });
  if (phone   && phone.length   > 50)   return res.status(400).json({ error: 'Phone too long' });
  if (email   && email.length   > 254)  return res.status(400).json({ error: 'Email too long' });
  if (comment && comment.length > 5000) return res.status(400).json({ error: 'Message too long' });
  const VALID = ['new', 'in_progress', 'completed', 'incomplete'];
  const queueNum = (Number(db.prepare('SELECT MAX(queue_number) AS m FROM applications').get().m) || 0) + 1;
  const result = db.prepare(`INSERT INTO applications (source,external_id,name,phone,email,comment,status,assigned_employee_id,queue_number)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(source||null, external_id||null, name.trim(), phone||null, email||null, comment||null,
         VALID.includes(status)?status:'new', assigned_employee_id||null, queueNum);
  res.json({ id: Number(result.lastInsertRowid), queue_number: queueNum });
});

app.put('/api/applications/:id', requireAuth, (req, res) => {
  const existing = db.prepare('SELECT * FROM applications WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const VALID = ['new', 'in_progress', 'completed', 'incomplete'];

  if (req.session.user.role !== 'admin') {
    const { status } = req.body;
    if (status && VALID.includes(status))
      db.prepare('UPDATE applications SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(status, req.params.id);
    return res.json({ ok: true });
  }

  const { source, name, phone, email, comment, status, assigned_employee_id } = req.body;
  if (name    !== undefined && String(name).trim().length  > 200)  return res.status(400).json({ error: 'Name too long' });
  if (phone   !== undefined && String(phone).length        > 50)   return res.status(400).json({ error: 'Phone too long' });
  if (email   !== undefined && String(email).length        > 254)  return res.status(400).json({ error: 'Email too long' });
  if (comment !== undefined && String(comment).length      > 5000) return res.status(400).json({ error: 'Message too long' });
  const assignedId = assigned_employee_id !== undefined ? (assigned_employee_id||null) : existing.assigned_employee_id;
  db.prepare(`UPDATE applications SET source=?,name=?,phone=?,email=?,comment=?,status=?,assigned_employee_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(source??existing.source, name??existing.name, phone??existing.phone, email??existing.email,
         comment??existing.comment, VALID.includes(status)?status:existing.status, assignedId, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/applications/:id', requireAdmin, (req, res) => {
  db.prepare('UPDATE applications SET deleted_at=CURRENT_TIMESTAMP WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});
app.post('/api/applications/:id/restore', requireAdmin, (req, res) => {
  db.prepare('UPDATE applications SET deleted_at=NULL WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});
app.delete('/api/applications/:id/permanent', requireAdmin, (req, res) => {
  const id = req.params.id;
  const atts = db.prepare('SELECT file_path FROM attachments WHERE application_id=?').all(id);
  for (const a of atts) { try { fs.unlinkSync(a.file_path); } catch (_) {} }
  db.prepare('DELETE FROM attachments WHERE application_id=?').run(id);
  db.prepare('DELETE FROM notes WHERE application_id=?').run(id);
  db.prepare('DELETE FROM applications WHERE id=?').run(id);
  res.json({ ok: true });
});

// ── Attachments ───────────────────────────────────────────────────────────────
app.get('/api/applications/:id/attachments', requireAuth, (req, res) =>
  res.json(db.prepare('SELECT * FROM attachments WHERE application_id=? ORDER BY created_at DESC').all(req.params.id))
);
app.post('/api/applications/:id/attachments', requireAuth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  if (!db.prepare('SELECT id FROM applications WHERE id=?').get(req.params.id))
    return res.status(404).json({ error: 'Application not found' });
  const r = db.prepare('INSERT INTO attachments (application_id,file_name,file_path,mime_type) VALUES (?,?,?,?)')
    .run(req.params.id, req.file.originalname, req.file.path, req.file.mimetype);
  res.json({ id: Number(r.lastInsertRowid), file_name: req.file.originalname });
});
app.delete('/api/attachments/:id', requireAdmin, (req, res) => {
  const att = db.prepare('SELECT * FROM attachments WHERE id=?').get(req.params.id);
  if (!att) return res.status(404).json({ error: 'Not found' });
  try { fs.unlinkSync(att.file_path); } catch (_) {}
  db.prepare('DELETE FROM attachments WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});
app.get('/api/attachments/:id/view', requireAuth, (req, res) => {
  const att = db.prepare('SELECT * FROM attachments WHERE id=?').get(req.params.id);
  if (!att || !fs.existsSync(att.file_path)) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Content-Type', att.mime_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${att.file_name.replace(/"/g, '')}"`);
  res.sendFile(path.resolve(att.file_path));
});

// ── Notes ─────────────────────────────────────────────────────────────────────
app.get('/api/applications/:id/notes', requireAuth, (req, res) =>
  res.json(db.prepare(`SELECT n.*, u.username FROM notes n JOIN users u ON n.user_id=u.id
    WHERE n.application_id=? ORDER BY n.created_at DESC`).all(req.params.id))
);
app.post('/api/applications/:id/notes', requireAuth, (req, res) => {
  const content = (req.body.content || '').trim();
  if (!content) return res.status(400).json({ error: 'Content required' });
  const r = db.prepare('INSERT INTO notes (application_id,user_id,content) VALUES (?,?,?)').run(req.params.id, req.session.user.id, content);
  res.json({ id: Number(r.lastInsertRowid) });
});

// ── Users ─────────────────────────────────────────────────────────────────────
app.get('/api/users', requireAdmin, (req, res) =>
  res.json(db.prepare('SELECT id,username,role,created_at FROM users ORDER BY created_at DESC').all())
);
app.post('/api/users', requireAdmin, (req, res) => {
  const { username, password, role } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (username.length > 50)  return res.status(400).json({ error: 'Username too long' });
  if (password.length > 200) return res.status(400).json({ error: 'Password too long' });
  if (!['admin','employee'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  if (db.prepare('SELECT id FROM users WHERE username=?').get(username))
    return res.status(409).json({ error: 'Username already exists' });
  const r = db.prepare('INSERT INTO users (username,password,role) VALUES (?,?,?)')
    .run(username.trim(), bcrypt.hashSync(password, 10), role);
  res.json({ id: Number(r.lastInsertRowid) });
});
app.delete('/api/users/:id', requireAdmin, (req, res) => {
  if (parseInt(req.params.id) === req.session.user.id)
    return res.status(400).json({ error: 'Cannot delete your own account' });
  db.prepare('DELETE FROM users WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ── Public web intake (no auth — for bot.html) ────────────────────────────────
app.post('/api/intake', (req, res) => {
  const { name, phone, email, comment } = req.body;
  if (!name?.trim())  return res.status(400).json({ error: 'Name is required' });
  if (!phone?.trim()) return res.status(400).json({ error: 'Phone is required' });
  if (name.trim().length  > 200)  return res.status(400).json({ error: 'Name too long' });
  if (phone.trim().length > 50)   return res.status(400).json({ error: 'Phone too long' });
  if (email   && email.length   > 254)  return res.status(400).json({ error: 'Email too long' });
  if (comment && comment.length > 5000) return res.status(400).json({ error: 'Message too long' });
  const queueNum = (Number(db.prepare('SELECT MAX(queue_number) AS m FROM applications').get().m) || 0) + 1;
  const result = db.prepare(`INSERT INTO applications (source,name,phone,email,comment,status,queue_number)
    VALUES ('web_form',?,?,?,?,'new',?)`)
    .run(name.trim(), phone.trim(), email||null, comment||null, queueNum);
  res.json({ id: Number(result.lastInsertRowid), queue_number: queueNum });
});

app.post('/api/intake/:id/attachment', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  if (!db.prepare('SELECT id FROM applications WHERE id=?').get(req.params.id))
    return res.status(404).json({ error: 'Application not found' });
  const r = db.prepare('INSERT INTO attachments (application_id,file_name,file_path,mime_type) VALUES (?,?,?,?)')
    .run(req.params.id, req.file.originalname, req.file.path, req.file.mimetype);
  res.json({ id: Number(r.lastInsertRowid) });
});

// ── Bot API (external bots with token) ───────────────────────────────────────
app.post('/api/bot/application', requireBotToken, (req, res) => {
  const { source, external_id, name, phone, email, comment } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name is required' });
  if (name.trim().length  > 200)  return res.status(400).json({ error: 'Name too long' });
  if (phone   && phone.length   > 50)   return res.status(400).json({ error: 'Phone too long' });
  if (email   && email.length   > 254)  return res.status(400).json({ error: 'Email too long' });
  if (comment && comment.length > 5000) return res.status(400).json({ error: 'Message too long' });
  if (external_id) {
    const dupe = db.prepare('SELECT id FROM applications WHERE external_id=?').get(external_id);
    if (dupe) return res.json({ id: Number(dupe.id), duplicate: true });
  }
  const queueNum = (Number(db.prepare('SELECT MAX(queue_number) AS m FROM applications').get().m) || 0) + 1;
  const r = db.prepare(`INSERT INTO applications (source,external_id,name,phone,email,comment,status,queue_number)
    VALUES (?,?,?,?,?,?,'new',?)`)
    .run(source||null, external_id||null, name.trim(), phone||null, email||null, comment||null, queueNum);
  res.json({ id: Number(r.lastInsertRowid), queue_number: queueNum });
});
app.post('/api/bot/application/:id/attachment', requireBotToken, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  if (!db.prepare('SELECT id FROM applications WHERE id=?').get(req.params.id))
    return res.status(404).json({ error: 'Application not found' });
  const r = db.prepare('INSERT INTO attachments (application_id,file_name,file_path,mime_type) VALUES (?,?,?,?)')
    .run(req.params.id, req.file.originalname, req.file.path, req.file.mimetype);
  res.json({ id: Number(r.lastInsertRowid) });
});

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'File too large (max 10 MB)' });
  if (err.message === 'File type not allowed') return res.status(400).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, '0.0.0.0', () => {
  const base = `http://localhost:${PORT}`;
  console.log('');
  console.log(`  CRM started  on port ${PORT}`);
  console.log(`  Local:  ${base}/login`);
  console.log('');
});
