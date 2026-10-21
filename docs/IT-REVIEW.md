# errand-mcp — IT / security review brief

Prepared for the customer's IT team ahead of install. Written 2026-09-01;
revised 2026-09-02 after an adversarial code review, 2026-09-30 after a
second review pass corrected statements that overstated what the code did,
and **2026-10-07 in response to your team's six review questions**. On
2026-10-21, before sending, a second adversarial review of that revision
found three more gaps in the code and several statements that overstated
it; the fixes and corrections are listed below and included throughout.
Most claims are checkable in this
repository, and we encourage reading the code — it is small on purpose
(three direct runtime dependencies, ~3,200 lines).

## Changes on 2026-10-07, by your question

1. **Booking confirmations** now return only a booking reference, the
   calendar event id, the driver's name, and whether the driver covers that
   zone. The calendar link, local file path, zone name and trip time were
   removed. Details: *What the assistant receives*.
2. **AI assistant platform and BAA**: answered in its own section below.
   To support that answer, three more paths were closed:
   - the mailbox listing now shows no email text at all;
   - viewing the attached request image is off unless your admin turns it
     on;
   - errors relayed from Microsoft or Google are reduced to a status and a
     code, because their text can quote what was sent.
3. **Cancelling a trip** in production now takes the same two-step
   confirmation as booking one. Booking a backlog in production now books
   only an explicit list of requests (the list the preview returns), and
   its confirmation is bound to that list. The software does not check that
   the preview was run, and drivers are re-checked at booking, so an
   assignment can differ from the preview. See *Safety controls* for who
   approves the second step.
4. **Attachment file names** are no longer requested from Microsoft at all.
   An attachment is reported under a neutral name built from the request's
   reference (`order-1a2b3c4d.jpg`). The same rule now covers every other
   sender-typed field: subject lines and body previews are gone from the
   listing.
5. **Appointment-time scheduling is built**: trips are booked at the time
   the request states, and are never moved to the next opening. Details:
   *Booking behavior*.
6. **Logging and retention**: a full inventory is below. Gaps fixed:
   - free-text mailbox searches are now redacted from the audit log (the
     search itself was removed on 2026-10-21);
   - relayed error text is reduced to status and code;
   - rotated audit files now have a retention window (before this they
     were never deleted);
   - the retention sweep now runs hourly instead of daily.

Fixed at the same time:

- **Double-booking.** A single booking used to be written to a separate
  board calendar that availability checks did not read; with a board
  calendar configured in production, the same driver could have been
  booked twice for the same time. Every live booking now lands on the
  assigned driver's own calendar, and a production configuration with a
  board calendar refuses to start.
- **Test mode.** Test mode must now name a scratch calendar and writes only
  there, so a test can never write to a real driver's calendar.
- **Stuck cancellations.** Cancelling a trip whose calendar event was
  already deleted by hand no longer gets stuck.

## Changes on 2026-10-21, after a second adversarial review

- **Attachment-only requests are flagged, not skipped.** An email with an
  attachment but no request lines in its text used to be treated as "not
  a request" and left out of the backlog without notice. It is now listed
  as `unreadable` in the mailbox listing and in the backlog preview, so the
  scheduler books it by hand.
- **The free-text mailbox search was removed.** It was the one input that
  invited a member's name, from a person or from the assistant itself. The
  listing now reads the recent inbox only.
- **One calendar write at a time.** Availability is read and the event is
  inserted in two separate calls, so two bookings running at once could
  both have picked the same free driver. Booking, backlog booking and
  cancelling now queue behind each other. A test forces two bookings to
  overlap and checks that the second waits for the first.
- **Token-refresh errors** from Microsoft or Google are now reduced to the
  HTTP status, like every other relayed error.
- **Statements corrected** (no code change): who approves the confirmation
  step, what the backlog preview guarantees, what the assistant can infer
  about a trip, when retention runs, what the ledger prevents, and the
  Google Workspace BAA requirement.

## What this software is

A scheduling assistant for non-emergency medical transportation dispatch.
Transportation Request emails arrive in a designated mailbox (e.g. requests
sent by a health plan). The software reads them and books each trip onto
the Google Calendar of a free driver from a roster, preferring the driver
who covers that part of town (derived from the ZIP code). The calendar
booking **is** the driver assignment. The scheduler keeps approvals and
judgment calls; the software does the repetitive lookup-and-book.

**Data in scope, stating exactly what is read and what isn't.** The
software reads **six labeled lines** from the request email's text: the
member's name, the pick-up address, the destination address, the
appointment date, the appointment time, and (when present) the pick-up
time. The label wording follows your Transportation Request form ("Member's
Name", "Pick-Up", "Destination", "Date of the Appointment", "Time of the
Appointment", "Pick-up Time"); common variants are accepted, and tests
cover them.

The rest of the form stays in your mailbox and is **not** parsed or copied
anywhere: member ID, phone, passenger count, special items and
instructions, mileage. If the form arrives as an attached image, that image
is filed for the scheduler (see retention below), but the software does not
read its contents.

Of what the software reads, the member's name and addresses are written to
exactly one place: the assigned driver's calendar event. (An attached form
image, which the software does not read, is filed on this machine as
described above.) The trip's date and times also appear in
the software's own job ledger and in the image folder's names, against a
reference number but never next to a name. Nothing is sent to any other
party; the requester is never contacted, and no other outside system is
involved.

It is a small program that runs on one computer in your office (Node.js 20
or newer). A person drives it through an assistant interface; it does
nothing on its own in the background. It is **not** a cloud service:
nothing is hosted by Liberty Coding, and no data is sent to Liberty Coding.

## Booking behavior — by appointment time

Each request is booked from its stated **pick-up time** to its stated
**appointment time**. If the request gives no pick-up time, the trip starts
a configured length before the appointment (default 60 minutes). Only
drivers whose calendars are free for that **entire** window are
considered. Among them, the driver who covers that part of town is
preferred; after that, a driver already working that zone that day. When a
backlog is booked in one run, no driver is given two overlapping trips.

**The software never moves a trip to a different time.** If no driver is
free for the window, the request is not booked and comes back to the
scheduler for a decision. The following are refused the same way:

- a request with no appointment date or time;
- a date or time in a format the software doesn't recognize (it does not
  guess);
- a time written without AM/PM that could be either, such as "2:00";
- a pick-up time at or after the appointment, or more than four hours
  before it;
- a time that has already passed;
- a date more than 90 days out, which is likelier a typo than a booking;
- a trip outside your configured service hours.

Refusal messages name the rule that failed, never the member's values;
tests check this. Wall-clock times follow your time zone, including across
daylight-saving changes, and tests cover that boundary.

Not done yet, stated plainly:

- **No appointment-time booking has yet been made against a real
  calendar.** The logic is covered by automated tests that run the real
  booking code with Microsoft and Google simulated. Against our real test
  mailbox we have verified the listing and the refusals. A live booking is
  the next step, and the sandboxed install test proposed below would do it
  on your calendars.
- **The return leg of a round trip** is not scheduled; only the outbound
  trip is booked.
- **The appointment lines must be in the email text.** A request that
  arrives only as an attached image cannot be booked automatically; it is
  listed as `unreadable` so the scheduler books it by hand.
- **No travel buffer.** A driver is free for a trip if no booking overlaps
  its window, so one trip can end exactly when the next begins. The zone
  is taken from the destination address.

The earlier soonest-free-slot behavior remains available as a
configuration setting for an instance that genuinely has no appointment
times. It is not the default, and a production configuration for your
transport flow would not use it.

## What the assistant receives — every tool result

The assistant passes ids and choices in, and gets back only what is listed
here.

- **Never:** a member's name, ID, phone number or address, or any text the
  sender typed.
- **About a trip, at most:** its reference number, when the request
  arrived and the sender's domain, its driver and whether that driver
  covers the trip's zone, and, on the backlog board, the trip's date and
  the zones each driver covers that day. A date and a zone can narrow a
  trip down, and dates count as identifiers under HIPAA's
  de-identification rules, so we describe this as minimum necessary, not
  de-identified.

| Action | Returns |
|---|---|
| Mailbox list | per message: message id, short ref (`order-1a2b3c4d`), received time, the **sender's domain** only, has-attachments, whether the request is complete / incomplete / unreadable (an attachment but no request lines, to book by hand) / not a request, the **names** of any missing labeled fields, booking state. No subject, body text, preview, or file names. |
| Attachment view | **Off by default** (instance setting `allowImageView`). If your admin enables it, it returns the request image under a neutral name. It is the only path that would show request content, and every use is audited. |
| Free/busy | driver names, their zones, count of busy blocks, the soonest open slot. |
| Book one request | booking ref, calendar event id, driver name, whether the driver covers that zone. |
| Backlog preview / book | per date: each driver's zones and trip count; per request: ref, message id (preview) or event id (book), driver, zone match; for each request that couldn't be booked: ref and the rule that stopped it; for each attachment-only request: ref, to book by hand. |
| Cancel | the cancelled event id, the request's previous state, and whether the event had already been deleted by hand. |
| Live confirmation step | the action and the arguments the operator supplied (ids, driver, zone), plus a one-time token. |
| Fetch a stored result | an oversized list result (same fields as the listing); images only if image view is enabled. |
| **Errors** | This software's own messages name the field or rule that failed, never a value. Errors from Microsoft or Google are reduced to provider, HTTP status and error code (e.g. `Microsoft Graph: HTTP 400 BadRequest`); their message text is dropped, because it can quote what was sent. |

Arguments the assistant can pass: instance, mode, action, message id(s),
driver name, zone name, day counts, result limit, and confirmation token.
There is no free-text input; the mailbox search was removed on 2026-10-21.
The software cannot stop a person from typing member details into the assistant
themselves, so the operating procedure is to refer to requests by ref, and
that is part of training.

## AI assistant platform and HIPAA

The assistant is **Claude, made by Anthropic**, operated through Anthropic's
desktop application. Stated plainly, the assistant **does not operate under
a HIPAA BAA today.** The demonstrations so far ran on Liberty Coding's own
Claude account, using staged, fictional requests only. The production operator would use an account your
organization holds, on a plan we agree with you before go-live.

- **Which Anthropic offerings carry a BAA.** Anthropic's published BAA
  documentation names its first-party API, Claude in Microsoft Foundry, and
  Enterprise plans as the offerings a BAA covers. For Enterprise, HIPAA
  configuration must be enabled.
- **Why a BAA would not cover this tool anyway.** The same documentation
  lists "Local MCP servers, which a member configures on their own
  computer" as **not covered**, and this software is exactly that.
- **What we did instead.** The software is built so that the assistant
  never receives a member's name, ID, phone number, address or
  appointment time. The table above lists every result it can return.
  Tests feed in a complete request (name, ID, phone, addresses,
  appointment) and check that none of it comes back out of the listing,
  the booking response, the backlog preview, or the audit log; a further
  test checks that an instruction written into an email does not reach the
  listing.
- **The remaining exposure** is a person typing member details into the
  assistant, which procedure and training cover. The software itself
  offers no free-text field to type them into.
- **The API route.** Anthropic's API is a covered offering. The tool could
  instead be driven by a small operator program of our own that calls the
  API under your organization's BAA, in place of the desktop application.
  That is a build of similar size to the no-assistant screen; we would
  scope it with you if you prefer it.
- **Liberty Coding's own role.** Supporting the install means access to a
  machine that holds request images, so Liberty Coding will sign a BAA
  with you covering that support access.
- **If your compliance officer requires the assistant itself to be under a
  BAA regardless**, the route Anthropic offers is Claude Enterprise with
  HIPAA configuration, contracted with Anthropic. Before relying on it, we
  would confirm with Anthropic that local tool servers remain usable under
  that configuration.

## Network surface — exhaustive

The process makes outbound HTTPS calls to four hostnames at two providers:

| Host | Purpose |
|---|---|
| `login.microsoftonline.com` | OAuth token refresh (Microsoft) |
| `graph.microsoft.com` | Read transport-request emails + attachments |
| `oauth2.googleapis.com` / `www.googleapis.com` | OAuth refresh; Calendar free/busy, event insert/delete |

There are no other endpoints: no telemetry, no analytics, no update checks,
no messaging providers.

**WhatsApp messaging was removed on 2026-09-01**, specifically because Meta
does not sign HIPAA Business Associate Agreements. The dispatch action and
its sending code were deleted then. Inert leftovers (a setup-template
stanza and unused config fields) were removed on 2026-09-02 after a code
review caught them. On 2026-10-07 the developer script's stale mapping was
removed, and the build now clears old compiled output so deleted code
cannot linger in it. A few historical mentions remain: code comments, one
defensive redaction pattern, test fixtures, and a legacy `dispatched` job
state the ledger still recognizes in old records. None of them can send
anything, and we would rather say so than have your reviewer find them.

The running software accepts no incoming network connections at all; it
only talks to the operator at the machine it runs on. The one exception is
on install day: the one-time Google sign-in script briefly listens on
127.0.0.1, this machine only, to receive the sign-in result.

## Permissions requested

| Provider | Scopes | What it can NOT do |
|---|---|---|
| Microsoft Graph | `Mail.Read`, `offline_access` | Cannot send, delete, move, or label mail. Read-only. |
| Google Calendar | `calendar.events`, `calendar.readonly` | Cannot touch Gmail, Drive, or contacts. |

The availability check needs `calendar.readonly`. Together, these Google
scopes can read events on every calendar the signed-in account can see, so
the account used for the install should see only the drivers' calendars.

Deployment note: the current build authenticates against the personal
Microsoft account authority (`/consumers`). That is the developer rig, not
the deployment shape. Deploying against your Microsoft 365 tenant is a
small configuration change: a tenant authority plus an admin-consented app
registration in your Entra ID, using the same read-only scope, which your
admin grants and can revoke centrally. It has not yet been exercised
against a live tenant, so we propose demonstrating it against yours in a
sandboxed test before any go-live decision. Appointment-time booking would
be verified live in the same test.

## Logging, retention, and access — every store

| Store | Contents | Member data? | Retention |
|---|---|---|---|
| Audit log `data/audit.jsonl` | One line per action: time, OS user, instance, mode, tool, action, redacted arguments, gate decision (allowed / confirmation issued / confirmed / denied), outcome, error (rule or status/code only, capped at 300 characters), duration | **No.** Credential-shaped keys are redacted. Member-, address-, appointment- and search-shaped keys are recorded as `<redacted:pii>`. Message ids are logged as the join key; subjects, senders and bodies never are. | Rotates at 10 MB. Rotated files are deleted after **6 years** by default, matching HIPAA's documentation-retention period; configurable from 30 days. |
| Job ledger `data/jobs.jsonl` | Per message id: booking state, driver, trip start/end, calendar and event id | No name, address, phone or ID. It does hold each trip's date and times against a message id. | Kept for the life of the install; it is what stops the same email from being booked twice. A request re-sent as a new email is not recognized as a duplicate. No automatic pruning today. |
| Request images `data/slips/<trip date>/<driver>/<pick-up time>_order-<ref>` | The attached form image, filed for the scheduler | **Yes.** This is where PHI rests on this machine. Folder and file names carry the trip date, driver and pick-up time, never a member's name. | Deleted **14 days after the trip date** by default (configurable). A trip booked weeks ahead keeps its image until two weeks after it happens: at most about 104 days, given the 90-day booking limit. Deletion runs while the tool is running; if it is not, deletion happens at its next start. |
| Temporary copies `data/handles/` | Oversized list results (same fields as the listing) and, only if image view is enabled, fetched image copies | Only if image view is enabled | Deleted about **24 hours** after creation (checked hourly). |
| Error output | Startup configuration failures only | No | Captured by the assistant application's log (below) |
| Assistant application logs (`%APPDATA%\Claude\logs` on Windows) | The assistant app's own record of tool-server activity | Only what the tools return (see *What the assistant receives*) | Governed by the assistant application, not by this software |

The retention sweeps run at startup and hourly while the tool is running.
The assistant application starts the tool, so on a machine where it is
closed for days, deletion catches up at its next start. Anthropic also processes
the conversation to run the assistant; it sees only what the tools return.

**Access control** is the operating system's. All stores live under the
install directory on a dedicated machine account. As a manual install step,
we restrict that directory with NTFS permissions to the dedicated account,
plus the scheduler's account for the image folder, on a BitLocker-encrypted
disk. The software has no user accounts of its own. Its gate restricts
*what can be done*, not *who is at the keyboard*, so machine access is the
access control.

## Safety controls in the code

- **Action gate** (`src/gate/`): everything the software can do is checked
  against a fixed permission list first, and anything not on the list is
  refused. In live mode, booking a request, booking a backlog and
  **cancelling** each need a two-step confirmation:
  - a single booking or cancel is tied to the request and to any requested
    driver or zone;
  - a backlog booking is tied to the exact list of requests passed in (the
    list the preview returns), and requests arriving between the two steps
    are not included.

  If the bound details change between the two steps, or a confirmation is
  replayed or reused for a different action, it is refused. The second
  step is a separate call, which the scheduler approves in the assistant
  application; we configure that application to ask before every booking
  or cancellation, and that setting is on the install checklist. The
  software itself cannot tell whether a person or the assistant made the
  second call. The trip time
  itself comes from the request, not from the operator; drivers are
  re-checked for availability at the moment of booking.
- **Test/live wall:**
  - Each configured instance lists the modes it may be addressed in; an
    instance without `"live"` cannot write to production calendars at all.
  - Test mode must name a scratch calendar and writes only there, even when
    it reads real drivers' availability.
  - Live configuration refuses a separate board calendar, so every live
    booking lands where the next availability check sees it.
- **Double-booking walls:** a request that is already booked is refused,
  not re-booked, and `cancel` is the explicit way back. A driver busy at
  any point in a trip's window is never chosen. Booking, backlog booking
  and cancelling run one at a time, so two bookings started together
  cannot both take the same free driver.
- **Fail-closed startup:** if any configuration is missing or wrong, the
  software refuses to start rather than run half-configured.
- **Private calendar events:** every event is created with its visibility
  explicitly set to private, so trip details never inherit a calendar's
  wider default sharing.

## Conditions of install — requirements, not recommendations

- **A dedicated mailbox.** The mailbox this tool reads must receive
  Transportation Request mail and nothing else: no shared inbox, no HR or
  vendor correspondence, no account-recovery mail for other services. The
  listing no longer shows any email text, but the software still reads each
  message server-side to classify it, and minimum-necessary access means it
  should have nothing else to read. This is a hard precondition we verify
  together before go-live.
- **Full-disk encryption and a dedicated machine account** on the install
  machine, with the install directory restricted as described above. The
  OAuth token files are protected by machine access controls, not their own
  encryption, so the disk must be.
- **Google Workspace under Google's BAA.** Each trip's member name and
  addresses are written to a driver's Google Calendar, so the drivers'
  calendars must be in a Google Workspace account covered by Google's BAA,
  just as the request mailbox should be under Microsoft's.
- **The request email template.** The labeled lines above must appear in
  the email text; we agree the template with the requester before go-live.
- **Support and incidents:** Liberty Coding is a one-person maintainer and
  says so plainly. Response expectations, an escalation contact, and what
  happens if the maintainer is unavailable are written into the service
  agreement rather than left to goodwill. Because the tool fails safe
  (requests simply wait in the mailbox), an outage delays scheduling but
  never loses or corrupts a request.

## Dependencies (complete list)

The running server depends directly on three packages:
`@modelcontextprotocol/sdk`, `zod` and `dotenv`. All are mainstream, with
no native modules. Including their own dependencies, about 95 packages are
installed, all pinned in `package-lock.json` and fetched only from the
public npm registry. To be complete: the one-time OAuth consent scripts
used during setup pull additional development-only packages (e.g. Google's
auth library). Those run once on install day and are not part of the
running service. `.env.example` lists every setting.

## Verification

- 130 automated tests, run with `npm test`. Among them:
  - the tool handlers themselves, with Microsoft and Google simulated:
    - the exact booking-confirmation fields;
    - which calendar a booking lands on, in test and in live mode;
    - the "no driver free" refusal;
    - live cancel and backlog confirmations;
    - attachment-only requests reported for a person, not dropped;
    - two overlapping bookings running one after the other;
    - the PHI-free listing;
    - an audit log free of request data;
  - the startup refusals;
  - error sanitizing;
  - gate policy;
  - per-field redaction;
  - request parsing with the form's labels;
  - appointment-time windows, including daylight saving;
  - driver choice;
  - image filing and retention, the ledger, and slot planning.
- TypeScript strict build: `npm run build`.
- Your team is welcome to full source access before and after install, and
  to run both commands themselves.

## Known limitations (stated, not hidden)

- Availability is tied to the machine it runs on; there is no failover.
  If the machine is off, requests simply wait in the mailbox and nothing
  is lost.
- Token files are protected by machine access controls, not their own
  encryption; hence the disk-encryption requirement above.
- The return leg of a round trip is not scheduled, image-only requests are
  flagged for the scheduler rather than read, and a live appointment-time
  booking has not yet been run (see *Booking behavior*).
- A request re-sent as a new email is not recognized as a duplicate of the
  first, so the scheduler should watch for corrected or repeated requests
  in the backlog preview.
- The job ledger is not pruned automatically.
- No automatic updates: changes are deployed deliberately, which your IT
  may consider a feature.

Questions to: Joshua Kammeraad, Liberty Coding LLC — joshua@libertycoding.net
