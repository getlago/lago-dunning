# Lago Dunning

One local app for **chat, manual payment reconciliation, and agent runs with schedules**.
It combines bank connectors, deterministic matching and audited allocations with the
dunning policy, payment behaviour and AI provider stack.

## Start

Requires Node.js 22.16+ and Python 3.11+ for AI chat. The web server,
reconciliation, collection previews, history and scheduler have no npm dependencies.

```sh
cp .env.example .env
npm run setup:ai
npm start
```

Open http://localhost:4320. The app defaults to connected accounts and reads invoices
from the configured Lago API. Email sending and payment writes require their explicit
server settings and user actions. Chat requires valid Bedrock or Anthropic credentials.

## Four screens

- **Chat:** real PydanticAI calls through the existing Bedrock/Anthropic stack. Tools
  read current evidence, run reconciliation and prepare collection previews. Chats and
  tool history persist. Sending is an explicit action by a person on a saved draft;
  model text cannot authorize it.
- **Manual payments:** incoming transfers, candidate invoices, evidence, approved payer
  identities, holds, rejection and approved payment recording. CSV import includes
  explicit column mapping. Payment corrections preserve allocation history.
- **Drafts:** review saved reminder emails and send each one to its customer with **Approve & send**.
- **Agent runs:** separate **Reconciliation** and **Dunning** cards, run controls,
  schedules and history filters. Reconciliation matches payments to invoices; Dunning
  evaluates overdue balances, payment history, pauses, prior reminders and contact
  limits. Dunning refreshes payment evidence before proposing reminders. Its outputs
  can be previews or saved drafts. Each workflow has independent five-field cron
  schedules and IANA timezones. Neither workflow automatically sends email, charges
  customers or approves bank matches.

## Connect accounts

1. Set `APP_MODE=connected`, keep `APP_ACCESS_MODE=local` for direct access on this computer,
   and configure Lago plus the relevant bank/Stripe credentials.
   For Qonto, `QONTO_ACCESS_TOKEN` uses the bearer connector when no connection mode is
   specified. Those tokens expire and are not static API keys.
   Set `QONTO_CONNECTION_MODE=oauth` explicitly to use a saved OAuth connection instead.
2. Set `REQUIRED_PAYMENT_SOURCES` to the sources that must be checked before collection,
   for example `lago,qonto,stripe`. The default is `lago`. Missing, failed or stale required
   sources hold collection.
3. Start with `ALLOW_LIVE_ACTIONS=false`, run a combined preview, and inspect payment matches.
4. Configure SMTP in **Workspace settings → Email**, or reuse Lago’s SMTP environment
   variables. See [SMTP setup](docs/email.md). The connection check never submits a message.
   Reminders are saved as drafts inside the app. Once SMTP is set up and checked,
   **Approve & send** emails the customer on the draft.
   `ALLOW_LIVE_ACTIONS` only controls manually approved financial writes.
   Browser requests carry a CSRF token; cross-origin, forwarded and unexpected-host
   requests are rejected.

Local access opens the workspace and all settings without a workspace access key. It
requires the loopback listener (`127.0.0.1`), including in connected mode. Optional
key access is available with `APP_ACCESS_MODE=key` and `ADMIN_KEYS`.

This version binds only to loopback and is a **single-organization local application**.
It is not a multi-tenant Lago deployment. Do not expose it through an unauthenticated proxy.
The default databases separate demo and connected records. Database mode is also recorded
and checked to prevent accidental reuse across modes. Preserve the data directory across restarts.
Credentials are server-side and excluded from version control. This app never returns
configuration secrets in API responses.

## Collection behaviour

The collection policy runs in the shared JavaScript service, with one database and one
execution coordinator. Model calls run in Python.

For finalized, overdue invoices, the app groups by internal customer ID **and currency**.
It checks manual holds, disputes, source health, proposed receipt matches, reserved
allocations and source divergence before applying cadence, materiality and payment
behaviour rules. Lago external customer IDs remain available as explicit metadata.

Outstanding balances subtract paid amounts and credit notes. A partial payment already
confirmed in Lago reduces the reminder balance; a proposed or pending cash allocation
holds collection without falsely declaring settlement. Behaviour scoring uses one final
settlement date per paid invoice, preferring `paid_at` over recording timestamps.

Before each saved draft, the app refreshes evidence and revalidates the entire proposed
invoice group, amount, recipient, action and content. Changed proposals are skipped.
The shared coordinator excludes overlapping runs and financial review actions. Actions are
recorded before creation. Ambiguous draft outcomes are not automatically replayed;
check Agent runs before intervening. Draft recipients, subjects and bodies are saved in SQLite and visible in run history.
Unsent drafts suppress further drafts for overlapping invoices, even after a cooldown.
Drafts do not count as sent contacts. They remain inside this app and keep collection on
hold for their invoices. Only a person can send a draft, one at a time, after SMTP is set up and checked.
A reviewed preview can be used once and expires after 15 minutes. Automated email sending and automatic charge
retry execution are disabled.

Customer memory is available from **Agent runs → Customer memory** and from each
draft or run customer. `collection_events` is an append-only timeline; linked
`collection_actions` track draft and submission state. SMTP acceptance updates the
draft and action atomically and counts one submission, not confirmed inbox delivery.
The default policy allows two submissions per rolling week, a 48-hour cooldown,
and human review after three contacts for still-unpaid invoices. Timing starts at
submission, not draft creation. A human can record a review and reset the escalation
cycle while preserving history, the weekly cap and cooldown.

Every send refreshes payment sources and rechecks invoice eligibility, remaining
balance, customer pauses, disputes, bank receipts, other drafts, cadence and content.
Stale unsent drafts can be refreshed and reviewed again or discarded. Uncertain
delivery blocks further contact until a person records a verified outcome.
**Needs attention** in Agent runs keeps persistent, deduplicated in-app escalation
records; reviewing an item does not override the underlying payment rules. No Slack
messages or automatic payment retries are sent by this workflow.

Reminder tone uses settled payment history from the last 12 months: fewer than
three settled invoices gives a neutral tone; less than 25% late gives a gentle
tone, 25–50% late stays neutral, and over 50% late gives a firm tone. Failed-payment
emails remain helpful and focus on updating the payment method. Draft review shows
both the tone and its evidence. The model receives contact counts and dates, but
not the reminder bodies, private portal links or human review notes.

For failed provider payments, saving a payment-method update draft fetches the customer's
Lago billing portal URL using their external ID. A failed lookup leaves a retryable failed
action and saves no incomplete email. Ordinary reminders do not request portal URLs.
Lago billing portal links last 12 hours; drafts use a five-minute safety margin and
block sending after expiry. Use **Refresh billing link** in draft review to replace the
link, then review and send explicitly. Refreshing never sends the email. Portal links
remain in saved drafts and are excluded from the model's context.

Communication scores and pause/contact history are in SQLite alongside receipts,
allocations, chat history and schedules. A wire is never written off or moved merely
because a matching score is high. The existing live multi-invoice/adjustment block remains:
those need an atomic Lago operation. Live reversals are review work, not silent deletion.

## Scheduling and persistence

Schedules are app-owned, not OS cron entries. Keep `npm start`
running under a process supervisor to execute jobs continuously. Closing the browser is
fine; stopping the server stops scheduling. On restart, interrupted runs are marked as
such and uncertain collection effects remain blocked. An overdue schedule runs once at
the next scheduler tick; missed slots are not replayed individually.

Five-field cron supports lists, ranges and steps. Day-of-month and weekday use standard
OR semantics when both are restricted. IANA timezones handle DST: nonexistent local
times are skipped; repeated local times can produce two due slots. Collection cadence
still prevents duplicate drafts. No schedules are created automatically.

## Layout

```text
public/              Four-screen UI; no client framework or build dependencies
src/server.js        Local API, access control, chat streaming and internal tool boundary
src/application.js   Shared run coordinator and payment review orchestration
src/dunning.js       Collection policy, fresh-evidence gate, templates and execution
src/store.js         Unified SQLite memory, chats, runs, schedules and collection outbox
src/scheduler.js     Persistent cron schedules and timezone-aware execution
src/ai/bridge.py     PydanticAI provider calls (no email transport)
src/cash/            Connector, matcher and allocation engine
test/                Integration, scheduling, security and collection regressions
test/cash/           Cash reconciliation regression suite
```

## Agent settings

Open **Agent runs → Agent settings**, or click the model below the chat composer.
The app discovers Bedrock text models and inference profiles in the configured region.
The catalogue is not a guarantee of invocation permission or tool compatibility: **Check & save**
runs a small synthetic tool-call test before persisting the selection. It sends no financial data.
If discovery permission is unavailable, the advanced model-ID option remains available.

Settings take precedence over the environment model default and survive restarts. Failed checks
retain the previous selection. Assistant preferences affect chat responses; existing scheduled
reconciliation and collection workflows still use their policy code. Changing settings resets
the provider's context on the next message, while preserving visible conversation history.
Each successful assistant message records its actual model and settings revision.

Lago continues to use `LAGO_API_KEY` on the server. No Lago sign-in or webhook is created by
saving agent settings. This remains a single-company local application. Configured workspace
members in key mode can inspect settings; only administrators can change them. Local access
can configure its assistant and connections directly.

## Verify

```sh
npm run check
```

Tests use temporary databases and fake providers, not real customers or payment writes.
The cash suite includes six adversarial scenarios. Other regressions
cover reconciliation-before-dunning, amounts/currencies, uncertain effects, schedules,
chat authorization and restart persistence.

## Limitations

This version runs locally, for one company. It is not certified for production use.

- Check each connector against your own accounts before relying on it. Those marked
  untested in `.env.example` have not been used with live accounts.
- There are no user roles, and one installation serves one company.
- Payments recorded in Lago use the server's API key, not an individual user's login.
- A payment that covers several invoices, or needs an adjustment, can be reviewed but
  not recorded automatically. Reversing a recorded payment is also a manual step.
- A customer on hold stays on hold until the payment question is resolved or someone
  updates the case. The app never resumes drafting on its own.
- The app does not read customer replies or promises to pay.

## License

MIT. See [LICENSE](LICENSE).
