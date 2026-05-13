# Heartworks Learning Center — Enrollment System

K–10 student enrollment system, refactored from a localStorage-only frontend
to a proper **Express + MySQL** backend with JWT authentication, while keeping
the entire original UI (registrar, cashier, admin, principal modules) intact.

```
Enrollment_system/
├── Backend/      ← Node.js + Express + MySQL API
└── Front-end/    ← Static HTML/CSS/JS — same UI, now talks to Backend
```

---

## What changed

The original system stored everything in the browser's `localStorage`.
This version moves the data to a real MySQL database, with a Node.js API
sitting in front of it. The frontend module code (`registrar.js`,
`cashier.js`, `admin.js`, `principal.js`) didn't need to change at all —
the data access layer (`shared/storage.js`) was rewritten to keep its
**synchronous public API** but back it with a cache that's warmed from
the API on page load.

### Highlights

- **MySQL schema** with proper relations (charges, payments, fee→grade
  mappings, payment→charge links), indexes, FK cascades, and a versioned
  migration runner.
- **JWT authentication** with **bcrypt-hashed passwords** (cost 12) —
  replaces the SHA-256-in-the-browser demo with real auth.
- **Parameterized queries everywhere** — every SQL call goes through
  `pool.execute(sql, [params])`, with column whitelisting for partial
  updates so a malicious caller can't sneak in unexpected `SET` clauses.
- **Transactional multi-row writes** — recording a payment, voiding,
  promoting a student, applying fees, and assigning subjects all run
  inside `START TRANSACTION ... COMMIT` so a half-failed operation can
  never corrupt the books.
- **Optimistic frontend writes** — the UI feels just as snappy as before;
  changes appear immediately and roll back with a toast if the server
  rejects them.
- **Layered architecture** — routes → controllers → services → db. No
  SQL in controllers, no `req`/`res` in services.

---

## Quick start

You'll be running two things side by side: the backend (Node.js process
on port `4000`) and the frontend (static files served any way you like —
even `file://` works in a pinch, though a tiny static server is better).

### 1. Database & Backend

```bash
cd Backend

# Install Node dependencies
npm install

# Configure your local environment
cp .env.example .env
# Open .env and fill in DB_USER / DB_PASSWORD for your MySQL.
# Then generate a real JWT_SECRET and paste it in:
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

# Apply migrations (creates the database if it doesn't exist)
npm run migrate

# Start the API
npm start
# → "Heartworks backend listening on http://localhost:4000"
```

If you see `Cannot connect to MySQL`, double-check that MySQL is running
and the credentials in `.env` are correct.

### 2. Frontend

The frontend is plain static files — no build step. The simplest options:

**Option A: Python's built-in server (works on any machine):**

```bash
cd Front-end
python3 -m http.server 5500
# Then open http://localhost:5500/auth.html in your browser
```

**Option B: VS Code "Live Server" extension** — right-click `auth.html`
→ "Open with Live Server".

**Option C: Open `auth.html` directly via `file://`.** This works for
the most part, though some browsers restrict `localStorage` and CORS
in odd ways with file URLs. Recommended only as a fallback.

### 3. Sign up and use

1. Open `auth.html` in your browser.
2. Click **Sign Up**, create an account, pick a role (Registrar /
   Cashier / Admin / Principal).
3. The page redirects you to your role's home. Everything from there
   on is real database persistence — refresh the page, your data is
   still there. Open another browser, sign in, see the same data.

---

## Project structure

```
Backend/
├── README.md              ← detailed backend docs
├── package.json
├── .env.example
├── migrations/
│   └── 001_init.sql       ← versioned schema
└── src/
    ├── server.js          ← entrypoint
    ├── routes.js          ← API surface (all under /api)
    ├── db.js              ← mysql2 pool + helpers
    ├── migrate.js         ← migration runner
    ├── util.js            ← ID gen + row → camelCase mappers
    ├── middleware/        ← auth (JWT), validation, error handling
    ├── controllers/       ← request/response, validation
    └── services/          ← SQL + business logic + transactions

Front-end/
├── auth.html              ← sign-in / sign-up page
├── auth.js                ← page-level auth controller (unchanged)
├── shared/
│   ├── config.js          ← + API_BASE
│   ├── api.js             ← NEW — fetch wrapper, JWT, 401 redirect
│   ├── storage.js         ← REWRITTEN — same public API, backed by cache + REST
│   ├── auth.js            ← REWRITTEN — calls /api/auth instead of SHA-256
│   ├── utils.js           ← unchanged
│   ├── csv.js             ← unchanged
│   └── logo.js            ← unchanged
├── modules/
│   ├── registrar/         ← HTML uses bootstrap pattern; JS unchanged
│   ├── cashier/           ← same
│   ├── admin/             ← same
│   └── principal/         ← same
└── assets/css/shared.css
```

---

## How the frontend's "synchronous storage" works post-migration

Each module page loads in this order:

1. `config.js`, `utils.js`, `api.js`, `storage.js`, `auth.js`, `logo.js`
   load as plain `<script>` tags. At this point `HLC_STORAGE` exists but
   its caches are empty.
2. An inline `<script>` calls `await HLC_STORAGE.bootstrap()` — this
   makes one `GET /api/bootstrap` call and fills the in-memory cache
   with every collection (students, payments, sections, subjects,
   faculty, misc fees, activity log, users, settings).
3. Once that resolves, the inline script appends a new `<script>` tag
   for the role module's JS file (e.g. `registrar.js`).
4. The role module runs as if nothing has changed. All its
   `Students.getAll()`, `Payments.getById(id)`, `buildGSA(...)` calls
   are synchronous — they read from the cache.
5. Writes (`Students.create(...)`, `recordPayment(...)`, etc.) update
   the cache **immediately** and fire an async `POST`/`PATCH`/`DELETE`
   in the background. On success, the cache entry is replaced with the
   server's authoritative copy. On failure, the cache rolls back and
   the user sees a toast.

This means the original module code (~160 KB of JS across 4 files)
keeps working with **zero changes**.

---

## Security notes

- **Passwords** are stored bcrypt-hashed at cost 12. The plain password
  never leaves the request handler.
- **JWTs** sign with `JWT_SECRET` from `.env`. The boot script refuses
  to start if you leave the placeholder in place.
- **All SQL** is parameterized via `pool.execute(sql, [...])`. Even
  variable-arity `IN (...)` lists generate placeholders dynamically and
  push values — no string-concat into SQL anywhere.
- **PATCH** endpoints whitelist the columns they'll touch
  (`PATCHABLE_FIELDS`) so unexpected JSON fields can't reach the
  database.
- **CORS** is `*` by default for local dev. For production, set
  `CORS_ORIGIN` in `.env` to the frontend's exact origin (or
  comma-separated allowlist).

---

## Operational tips

- `npm run migrate` is idempotent — re-running it does nothing if the
  schema is current. To add new migrations, drop a file like
  `migrations/002_add_x.sql` and re-run.
- The server pings MySQL on boot. If the DB is down or credentials are
  wrong, you get a clear `[fatal]` message and the process exits — not
  a silent hang.
- A health check is at `GET /health` (no auth needed).
- All multi-row mutations (record payment, void payment, promote
  student, apply fees, assign subjects) run inside transactions, so a
  half-failed write can never leave the books in a corrupted state.

For more detail on the backend, see `Backend/README.md`.
