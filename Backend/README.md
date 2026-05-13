# Heartworks Learning Center — Backend

Express + MySQL backend for the K–10 Enrollment System. Replaces the original
`localStorage`-only frontend persistence with proper server-side data, JWT
auth, and a versioned schema.

---

## What you need

- **Node.js 18+** (any LTS)
- **MySQL 5.7+** or **MariaDB 10.4+** running locally
- A user that can `CREATE DATABASE` (the migrate script creates the DB if it
  doesn't already exist)

---

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Create your local config
cp .env.example .env
# Open .env and fill in DB_USER / DB_PASSWORD, then generate a real JWT_SECRET:
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
# Paste that into JWT_SECRET=...

# 3. Apply migrations (creates the DB on first run)
npm run migrate

# 4. Start the server
npm start
# → "Heartworks backend listening on http://localhost:4000"
```

Open the front-end (the `Front-end/auth.html` file in this delivery) and
sign up — your account is created in the `users` table, you'll be issued a
JWT, and everything from there on is real database persistence.

---

## Project layout

```
Backend/
├── migrations/            ← *.sql, applied in numeric filename order
│   └── 001_init.sql
├── src/
│   ├── server.js          ← entrypoint
│   ├── routes.js          ← API surface (mounted at /api)
│   ├── db.js              ← mysql2 pool + query helpers
│   ├── migrate.js         ← migration runner
│   ├── util.js            ← ID generation + row → camelCase mappers
│   ├── controllers/       ← thin request/response, validation, status codes
│   ├── services/          ← business logic, transactions, hydration
│   └── middleware/
│       ├── auth.js        ← JWT verify + role guard
│       ├── validate.js    ← request-body validation helpers
│       └── errorHandler.js← HttpError + central error mapper
├── package.json
├── .env.example
└── .gitignore
```

The split is the conventional Express layered architecture:

- **routes.js** wires URL → controller, applies auth middleware
- **controllers/** parse and validate input, format responses, map errors to
  HTTP status codes — *no SQL here*
- **services/** own all SQL and business logic. Multi-row writes run inside
  transactions (`db.withTransaction(fn)`). *No `req`/`res` here*
- **db.js** hands out parameterized queries through a pool. Every query in
  every service goes through it.

---

## API surface (all under `/api`)

Authentication (no token required for the first two):

| Method | Path                | What it does                          |
|-------:|---------------------|----------------------------------------|
|  POST  | `/auth/signup`      | Create user, return user + JWT        |
|  POST  | `/auth/login`       | Verify creds, return user + JWT       |
|  GET   | `/auth/me`          | Refresh the JWT-bound user record     |

Everything else needs `Authorization: Bearer <jwt>`:

| Method | Path                                        |
|-------:|---------------------------------------------|
|  GET   | `/bootstrap`                                | full snapshot of every collection |
|  GET / POST / PATCH / DELETE   | `/students`, `/students/:id` |
|  POST  | `/students/:id/charges`                     | add one-off charge        |
|  POST  | `/students/:id/auto-fees`                   | apply school-wide + grade fees |
|  POST  | `/students/:id/optional-fees`               | apply one optional fee    |
|  POST  | `/students/:id/subjects`                    | assign subjects (zero-amount charges) |
|  POST  | `/students/:id/grade-change`                | correction or promotion   |
|  POST  | `/students/:id/payments`                    | record a payment          |
|  GET / POST | `/payments`, `/payments/:id`           |                            |
|  POST  | `/payments/:id/void`                        | soft-delete (preserves audit trail) |
|  GET / POST / PATCH / DELETE | `/misc-fees`, `/misc-fees/:id` |                            |
|  GET / POST / PATCH / DELETE | `/sections`, `/sections/:id` |                            |
|  GET / POST / PATCH / DELETE | `/subjects`, `/subjects/:id` |                            |
|  GET / POST / PATCH / DELETE | `/faculty`, `/faculty/:id`   |                            |
|  GET / POST / PATCH / DELETE | `/users`, `/users/:id`       | self-delete blocked       |
|  GET / POST | `/activity-log`                       | append-only (audit log)    |
|  GET / PUT  | `/settings/:key`                      | generic key/value          |
|  GET / PUT  | `/settings/active-school-year`        | typed shortcut             |

Health probe (no auth):

| Method | Path     | What it does          |
|-------:|----------|-----------------------|
|  GET   | `/health`| `{ "ok": true }`      |

---

## Security notes

- **All queries are parameterized** via `pool.execute(sql, [...])`. User
  input never makes it into SQL as a string. Where `IN (...)` lists need
  variable arity, the placeholders are generated and the values pushed —
  see `studentsService.getAll()` for an example.
- **Identifier whitelisting** in `studentsService.update()`: only known
  columns can appear in a `SET` clause, even if a malicious caller sneaks
  arbitrary keys into the JSON body.
- **Passwords** are hashed with bcrypt at cost 12. The plain password never
  leaves the request handler.
- **JWTs** carry `{ sub, role, email }` for transport, but every protected
  request also runs an indexed `SELECT` against `users` to confirm the
  account still exists and to read the *current* role. A deleted user
  can't keep working off an unexpired token, and role changes take effect
  on the next request. Use a long random `JWT_SECRET` (the boot script
  refuses to start with the placeholder).
- **CORS** is configurable via `CORS_ORIGIN` (comma-separated allowlist).
  Use `*` only for local dev.

---

## Operational tips

- `npm run migrate` is idempotent. Re-running it does nothing if the
  schema is up to date. To add a new migration, drop a new
  `migrations/00N_whatever.sql` and run it again.
- The server pings MySQL on boot — if the DB is down or credentials are
  wrong, you'll see a clear `[fatal]` message instead of a silent hang.
- All multi-row mutations (record payment, void payment, promote student,
  apply fees, assign subjects) run inside transactions, so a half-failed
  write can never leave the books in a corrupted state.

---

## Quick smoke test

After `npm start`, in another terminal:

```bash
# Health check
curl http://localhost:4000/health
# → {"ok":true}

# Sign up
curl -X POST http://localhost:4000/api/auth/signup \
  -H 'Content-Type: application/json' \
  -d '{"fullName":"Test User","email":"test@example.com","password":"testpass","role":"registrar"}'
# → {"user":{...},"token":"eyJ…"}

# Save the token, then:
TOKEN=eyJ…
curl http://localhost:4000/api/bootstrap -H "Authorization: Bearer $TOKEN"
# → {"students":[],"payments":[],...}
```

If you can do those three calls successfully, the backend is fully wired.
