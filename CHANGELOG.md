# K-10 Cashier + Enrollment fixes — 2026-05-23

Three fixes, all related to charges showing up at the cashier.

## 1. "Add charge failed: Validation failed"

**File:** `Front-end/shared/storage.js` (function `addCharge`)

**Root cause:** The cashier's "Add charge" form reads `amount` from a text
input, which gives a string like `"500"`. The frontend was forwarding that
string straight to `POST /api/students/:id/charges` without converting it.

The backend validator (`Backend/src/middleware/validate.js`) requires
`amount` to be a real JS `number` via `typeof v === 'number'`, so the string
failed validation and the server returned `400 Validation failed`. The
frontend's background-write helper surfaced that as the toast:

    Add charge failed: Validation failed

**Fix:** Coerce `amount` with `Number(chargeData.amount) || 0` before
sending. The optimistic local cache was already coercing on its own copy,
so cache and server now agree.

## 2. School-wide and grade-specific fees never auto-applied on enrollment

**Files:**
  - `Backend/src/controllers/students.controller.js` (create + update)
  - `Backend/src/services/onlineEnrollmentService.js` (review/approve)
  - `Backend/src/services/studentsService.js` (new `getStatus` helper)

**Root cause:** The backend has an `applySchoolWideFees(studentId)` service
that picks up every `misc_fees` row with `auto_apply=1` for the active
school year and inserts a `'misc-fee'` charge per fee (filtering by scope:
school-wide always, grade-targeted only if the student's grade matches).

But this function was **never called during enrollment**. It only ran when:
  - the cashier manually clicked "Apply fees" in the UI
  - a misc fee was created/edited (back-fill to existing students)
  - a student was promoted to the next grade

Result: every newly enrolled student showed up at the cashier with zero
billable charges, even though school-wide tuition / book / activity fees
were defined in the system. The cashier had no way to collect from them
unless someone manually triggered the apply flow per student.

**Fix:** Wire `applySchoolWideFees` into the three places where a student
*becomes* approved/enrolled:

  1. `students.controller.js#create` — if the create payload sets
     `status` to `approved` or `enrolled` (e.g. bulk import), apply fees
     immediately and return the student WITH the new charges.

  2. `students.controller.js#update` — if the patch transitions status
     from `pending`/`rejected` into `approved`/`enrolled`, apply fees.
     Uses a new `studentsService.getStatus()` helper to read the prior
     status before the update so we only act on the transition (not on
     every subsequent edit). Avoids redundant SQL on already-approved
     students.

  3. `onlineEnrollmentService.js#review` — when `nextStatus === 'approved'`
     (used by both walk-in registration, which auto-approves, and online
     enrollment, which the registrar manually approves).

All three call sites use the same error-handling shape: the fee
application is best-effort, run AFTER the status-update transaction, and
logs to the server console on failure. The student is still approved
even if fees fail to attach — the cashier can re-trigger via the
existing "apply auto-fees" path, and `applySchoolWideFees` is idempotent
(it skips fees already on the student) so retries are safe.

## 3. "Collect Payment" empty-state message

**File:** `Front-end/modules/cashier/cashier.js` (function
`populateCollectStudents`)

**Root cause:** When no students qualified for the dropdown, the message
just said "No students have charges yet" with no hint about WHY.

**Fix:** With fix #2 in place, the only ways for the dropdown to be empty
are (a) no students in the system, (b) every student is still pending
registrar approval (fees apply on approval), or (c) no auto-apply misc
fees are defined for the active school year. The empty-state message now
distinguishes between those three cases so the cashier knows exactly
what's blocking them.

## Files changed

    Backend/src/controllers/students.controller.js
    Backend/src/services/onlineEnrollmentService.js
    Backend/src/services/studentsService.js
    Front-end/shared/storage.js
    Front-end/modules/cashier/cashier.js

## How to verify

Backend changes need a server restart (kill `node src/server.js` and
restart). Frontend changes need a hard refresh (Ctrl+Shift+R).

1. As **admin/cashier**, in the cashier "Charges & Fees" tab, define at
   least one misc fee with `auto_apply = true` and scope `school-wide`
   for the active school year. (Or grade-specific targeting Grade 1.)

2. As **registrar**, enroll a new student via the front-desk form. The
   walk-in path auto-approves, so the student is created already in
   `approved` status.

3. Switch to the **cashier** module, go to "Collect Payment". The new
   student should appear in the dropdown with the school-wide / grade
   fee amount as the "Due" total.

4. Pick the student, select the charge(s), enter cashier name, record
   the payment. Receipt should print.

5. For the online-enrollment path: have a parent submit, then as
   registrar click "Approve" on the submission. Then check the cashier
   dropdown — the approved student should appear with their auto-applied
   fees.

## Note on existing students

Students who were enrolled BEFORE this fix won't retroactively get fees.
Two ways to fix them up:

  - Per-student: the cashier UI already has a per-student "Apply auto
    fees" button (calls `POST /api/students/:id/auto-fees`).
  - Bulk: the cashier UI has a "Bulk apply fees" action that loops over
    all students.

Both still work as before. `applySchoolWideFees` is idempotent, so
running it on already-billed students is a safe no-op.
