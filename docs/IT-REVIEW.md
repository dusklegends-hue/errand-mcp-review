# errand-mcp — IT / security review brief

Prepared for the customer's IT team ahead of install. Written 2026-09-01;
revised 2026-09-02 after an adversarial code review, and again 2026-09-30
after a second review pass corrected several statements that overstated
what the code does. Most claims are checkable in this repository, and we
encourage reading the code — it is small on purpose (three direct runtime
dependencies, ~2,600 lines).

## What this software is

A scheduling assistant for non-emergency medical transportation dispatch.
Transportation Request emails arrive in a designated mailbox (e.g. requests
sent by a health plan); the software reads them, picks a free driver from a
roster (preferring the driver who covers that part of town, derived from the
ZIP code), and books the trip onto that driver's Google Calendar. The
calendar booking **is** the driver assignment — the scheduler keeps
approvals and judgment calls; the software does the repetitive
lookup-and-book.

**Data in scope — exhaustive, and honest about what is read vs. what
isn't.** Today the software reads **three labeled lines** from the request
email: the member's name, the pick-up address, and the destination address
(the label wording is flexible — "Member's Name", "Pick-Up", "Destination"
and common variants are all accepted, covered by tests). The rest of the
Transportation Request form — member ID, phone, passenger count,
appointment time, special items, mileage — stays in your mailbox and is
**not** parsed or copied anywhere by the current build; if the form arrives
as an attached image, that image is filed for the scheduler (see retention
below) but its contents are not read by the software. What is read is
written to exactly one place: the assigned driver's calendar event. Nothing
is transmitted to any other party — the requester is never contacted, and
no other outside system is involved.

**Booking behavior, stated plainly:** the current build books the soonest
free slot inside configured service hours (and can plan a multi-day backlog
by zone). Booking around the form's stated appointment time is designed but
not yet built — it is the agreed next feature before live use, since a
2:00 PM appointment must not be booked as a 10:52 AM trip.

It is a small program that runs on one computer in your office (Node.js 20
or newer). A person drives it through an assistant interface; it does nothing
on its own in the background. It is **not** a cloud service: nothing is
hosted by Liberty Coding, and no data is sent to Liberty Coding.

## Network surface — exhaustive

The process makes outbound HTTPS calls to four hostnames at two providers:

| Host | Purpose |
|---|---|
| `login.microsoftonline.com` | OAuth token refresh (Microsoft) |
| `graph.microsoft.com` | Read transport-request emails + attachments |
| `oauth2.googleapis.com` / `www.googleapis.com` | OAuth refresh; Calendar free/busy, event insert/delete |

There are no other endpoints: no telemetry, no analytics, no update checks,
no messaging providers. **WhatsApp messaging was removed on 2026-09-01**
specifically because Meta does not sign HIPAA Business Associate
Agreements: the dispatch action and its sending code were deleted then, and
inert leftovers (a setup-template stanza and unused config fields) were
removed on 2026-09-02 after a code review caught them. A few historical
mentions remain in code comments and in one defensive redaction pattern;
none of them can send anything, and we would rather say so than have your
reviewer find them. The running software accepts no incoming network
connections at all — it only talks to the operator at the machine it runs
on. (The one-time Google sign-in script used on install day briefly listens
on 127.0.0.1, this machine only, to receive the sign-in result.)

## Permissions requested — only what it needs

| Provider | Scopes | What it can NOT do |
|---|---|---|
| Microsoft Graph | `Mail.Read`, `offline_access` | Cannot send, delete, move, or label mail. Read-only. |
| Google Calendar | `calendar.events`, `calendar.readonly` | Cannot touch Gmail, Drive, or contacts. |

Note for deployment, stated honestly: the current build authenticates
against the personal Microsoft account authority (`/consumers`) — that is
the developer rig, not the deployment shape. Deploying against your
Microsoft 365 tenant is a small configuration change (tenant authority + an
admin-consented app registration in your Entra ID, using the same read-only
scope), which your admin grants and can revoke centrally — but it has not
yet been exercised against a live tenant, so we propose demonstrating it
against yours in a sandboxed test before any go-live decision.

## Credentials and data at rest

- OAuth **refresh tokens** live in local files on the install machine
  (`.ms-tokens.json`, `.tokens.json`); client ids/secrets in a local `.env`.
  Nothing is hardcoded; configuration names environment variables, it never
  contains secrets. Required (see Conditions of install below): a dedicated machine account and full-disk
  encryption (BitLocker) — the standard controls for any workstation touching
  PHI.
- **Job ledger** (`data/jobs.jsonl`): mail id, driver name, slot times,
  calendar event id. Records written since 2026-09-01 store **no member
  names, addresses, or phone numbers**, and on 2026-09-02 the older
  development-era entries that predated that change were purged of those
  fields as well.
- **Request-image folder** (`data/slips/<date>/<driver>/`): where PHI
  rests on this machine. When a request arrives with a photo or
  image of the form attached, that image is
  filed by date and driver for the scheduler's workflow and
  **auto-deleted after a configurable retention window (default 14 days)**.
  The only other disk location is temporary attachment copies
  (`data/handles/`, written when an operator fetches an attachment), which
  are auto-deleted after 24 hours. The sweep
  runs at every startup and once a day while the process stays up. No file
  or folder name contains member data.
- **Audit log** (`data/audit.jsonl`): every action, with parameters passed
  through a redactor before writing — credential-shaped keys become
  `<redacted>`, and member/address/phone-shaped keys become
  `<redacted:pii>` (see `src/audit/redact.ts`). Every field named in the
  data-in-scope list above has its own redaction test, so a regression
  names the exact field it dropped. The audit log records *that* a member
  name/address was present, never the value.

**PHI-blind scheduling (2026-09-01):** the person or AI assistant operating
the tool does not see member data when scheduling. To schedule a trip, the
operator passes only a message id; the software fetches the request email
itself, reads the labeled fields internally, books the calendar event, and
reports back without any member values. There is no way to even pass a
member name or address into the schedule action — the arguments don't
exist — and the audit entries for scheduling carry no PHI.

Two exceptions, stated plainly. First, the mailbox listing shows each
email's subject line and a short text preview; the three parsed fields are
masked in that preview, but other form fields that appear in the email text
(for example member ID or phone) are not. Changing the listing to show no
email text at all is a small change we propose making before go-live.
Second, there is an opt-in view of an attached request image, which shows
the whole form; that view is audited.

PHI (member name, pick-up/destination addresses, trip time) exists in two
places only, both already inside your estate: the **request email** in your
mailbox, and the **calendar event** created for the driver. Compliance note for your officer: Microsoft
365 and Google Workspace both offer BAAs covering Exchange/Calendar — this
tool introduces no processor beyond those two, and Liberty Coding receives
no PHI. If your policy requires a BAA with the maintainer regardless (e.g.
for support access), Liberty Coding will sign one.

## Safety controls in the code

- **Action gate** (`src/gate/`): everything the software can do is checked
  against a fixed permission list first; anything not on the list is
  refused. Booking changes in live mode need a two-step confirmation tied
  to the request and any requested driver or zone — if those change between
  the two steps, or the same confirmation is replayed, it is refused. The
  time slot itself is chosen after confirmation, from the driver's free
  time.
- **Test/live wall:** each configured instance lists the modes it may be
  addressed in; an instance without `"live"` cannot write to production
  calendars at all. Test mode writes only to a scratch calendar.
- **Double-dispatch wall:** a request that is already scheduled is refused,
  not re-booked; `cancel` is the explicit way back.
- **Fail-closed startup:** if any configuration is missing or wrong, the
  software refuses to start rather than run half-configured.
- **Private calendar events:** every event is created with its visibility
  explicitly set to private, so trip details never inherit a calendar's
  wider default sharing.

## Conditions of install — requirements, not recommendations

- **A dedicated mailbox.** The mailbox this tool reads must receive
  Transportation Request mail and nothing else — no shared inbox, no HR or
  vendor correspondence, no account-recovery mail for other services. The
  tool's mail-listing view shows the inbox to the operator (with the three
  parsed fields masked), so a mixed-use inbox would expose unrelated mail. This is
  a hard precondition we verify together before go-live.
- **Full-disk encryption and a dedicated machine account** on the install
  machine. The OAuth token files are protected by machine access controls,
  not their own encryption, so the disk must be.
- **Support and incidents:** Liberty Coding is a one-person maintainer and
  says so plainly. Response expectations, an escalation contact, and
  what happens if the maintainer is unavailable are written into the
  service agreement rather than left to goodwill — and because the tool
  fails safe (requests simply wait in the mailbox), an outage delays
  scheduling but never loses or corrupts a request.

## Dependencies (complete list)

The running server depends directly on three packages —
`@modelcontextprotocol/sdk`, `zod`, `dotenv` — all mainstream, no native
modules. Including their own dependencies, about 95 packages are installed,
all pinned in `package-lock.json` and fetched only from the public npm
registry. To be complete: the one-time OAuth consent scripts used during
setup pull additional development-only packages (e.g. Google's auth
library); those run once on the install day and are not part of the
running service.

## Verification

- 68 automated tests (gate policy, per-field PHI redaction, request-email
  parsing including the Transportation Request form's labels, image filing
  + retention, ledger, slot search, day planning) — run `npm test`.
- TypeScript strict build — `npm run build`.
- Your team is welcome to full source access before and after install, and
  to run both commands themselves.

## Known limitations (stated, not hidden)

- Availability is tied to the machine it runs on; there is no failover.
  If the machine is off, requests simply wait in the mailbox — nothing is
  lost.
- Token files are protected by machine access controls, not their own
  encryption; hence the disk-encryption requirement above.
- No automatic updates: changes are deployed deliberately, which your IT
  may consider a feature.

Questions to: Joshua Kammeraad, Liberty Coding LLC — joshua@libertycoding.net
