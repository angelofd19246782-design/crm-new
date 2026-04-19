# CRM + Bot

Simple CRM with a web bot intake form. Node.js + Express + SQLite + Vanilla HTML/CSS/JS.

**Requires Node.js 22 or newer** (uses the built-in `node:sqlite` module).

---

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Create your local .env (copy the example, defaults work as-is)
cp .env.example .env

# 3. Start the server
npm start
```

Open in browser:

| Page | URL |
|------|-----|
| Login | http://localhost:3000/login |
| Admin panel | http://localhost:3000/admin |
| Employee panel | http://localhost:3000/employee |
| Bot / client form | http://localhost:3000/bot |

---

## Default accounts (seeded on first run)

| Role | Username | Password |
|------|----------|----------|
| Admin | `admin` | `admin123` |
| Employee | `demo_employee` | `employee123` |

The database is seeded automatically the first time the server starts.
**Change the admin password after your first login.**

---

## Dev mode (auto-restart on file changes)

```bash
npm run dev
```

Uses Node.js built-in `--watch` flag — no extra dependencies needed.

---

## File locations

| Item | Path |
|------|------|
| Database | `crm.db` (created automatically) |
| Uploads | `uploads/` (created automatically) |
| Environment | `.env` |

---

## Project structure

```
crm-new/
├── public/          # Static frontend (HTML/CSS/JS)
│   ├── login.html
│   ├── admin.html
│   ├── employee.html
│   └── bot.html
├── uploads/         # Uploaded files (auto-created)
├── server.js        # Express app + all API routes
├── db.js            # SQLite setup + auto-migration + seeding
├── .env             # Local config (copy from .env.example)
├── .env.example     # Config template
└── crm.db           # SQLite database (auto-created)
```

---

## Deploy to Railway

### Steps

1. Push the project to a GitHub repository (`.env`, `crm.db`, and `uploads/` are in `.gitignore` and will not be committed).
2. Create a new Railway project → **Deploy from GitHub repo**.
3. Set environment variables in the Railway dashboard under **Variables**:

| Variable | Value |
|----------|-------|
| `SESSION_SECRET` | A long random string (32+ chars) |
| `BOT_API_TOKEN` | A secret token for the external bot API |
| `NODE_ENV` | `production` |

> `PORT` is set automatically by Railway — do not set it manually.

4. Railway will run `npm start` automatically.

### Important: data persistence

Railway containers have an **ephemeral filesystem** — `crm.db` and uploaded files are reset on every redeploy.

To persist data across deploys:
- Go to your Railway service → **Volumes** → add a volume mounted at `/app` (or wherever your repo is checked out).
- With a volume, `crm.db` and `uploads/` survive redeploys.

Without a volume, the admin account is re-seeded from scratch on each deploy (safe for testing, not for production).

---

## Routes

### Pages
- `GET /` — redirects to `/login` or `/admin`/`/employee` based on session
- `GET /login` — login page
- `GET /admin` — admin panel (redirects to `/login` if not authenticated)
- `GET /employee` — employee panel (redirects to `/login` if not authenticated)
- `GET /bot` — public client intake form

### API
- `POST /auth/login` — login
- `POST /auth/logout` — logout
- `GET /auth/me` — current session user
- `POST /api/intake` — public, no auth — web bot form submission
- `POST /api/intake/:id/attachment` — public, no auth — bot file upload
- `GET /api/applications` — list applications (auth required)
- `PUT /api/applications/:id` — update application
- `DELETE /api/applications/:id` — soft-delete (admin only)
- `GET /api/stats` — dashboard stats (auth required)
- `GET /api/users` — list users (admin only)
- `POST /api/users` — create user (admin only)
- `POST /api/bot/application` — external bot endpoint (requires `x-bot-token` header)
