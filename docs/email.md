# SMTP and reminder drafts

The app uses the same SMTP configuration conventions as Lago. Reminders are saved in the app's SQLite database and displayed
in Drafts. SMTP itself does not store drafts in a mailbox.

**Sending.** Once SMTP is set up and checked, use **Drafts → Review draft → Approve & send**.
The email goes to the customer's billing address on the draft, and only there. The request
cannot choose a different address or add Cc/Bcc. Only a workspace administrator can send drafts.
Before sending, send a draft to yourself (for example by setting your own address as a test
customer's billing email in Lago) to check how reminders look.

Scheduled runs and the AI still only prepare drafts. Duplicate clicks are rejected after
submission. An uncertain result or a process interruption requires inbox review; it is not
automatically retried. Explicit SMTP rejection permits another attempt. A successful SMTP
response means acceptance by that server, not verified inbox delivery. The app uses a delivery SMTP provider with TLS. The previous local test bridge has been removed.

Connection checks remain separate: they use EHLO, optional TLS/authentication, NOOP and
QUIT without submitting a message.
## Configure a provider

Open **Workspace settings → Email → Configure SMTP**. Enter the host, port, security,
sender address and credentials supplied by your provider, then choose **Check & save**.
Settings are only replaced after a successful connection check. Passwords are encrypted
at rest, never returned to the browser, and never passed to the AI process.

Common configurations use STARTTLS on port 587 or implicit TLS on 465; follow your provider's
instructions. Certificate verification is required. Application email delivery requires TLS.

Alternatively configure these Lago-compatible variables on the server:

- `LAGO_SMTP_ADDRESS`, `LAGO_SMTP_PORT`
- `LAGO_SMTP_USERNAME`, `LAGO_SMTP_PASSWORD`
- `LAGO_FROM_EMAIL`
- `SMTP_STARTTLS=true` for required STARTTLS; `SMTP_SSL=true` for implicit TLS.

Legacy `SMTP_USERNAME`, `SMTP_PASSWORD`, and `MAIL_FROM` remain accepted aliases. Explicit
server configuration takes precedence over the form. A changed configuration requires a
fresh check before the UI labels it verified. Connection checks don't validate sender-domain
authorization or actual deliverability, since no message is submitted.

SMTP settings are encrypted in SQLite with a separate `.secrets/smtp.key` (0600). Preserve
both in a protected backup. Existing invoices, payment connections and old run history
are not removed when switching email providers.

References: [Lago SMTP configuration](https://getlago.com/docs/guide/lago-self-hosted/docker),
[Lago email behaviour](https://getlago.com/docs/guide/emails).

## Resend

Use **Email settings → Use Resend** to fill `smtp.resend.com`, port `465`, TLS,
username `resend`, and the test sender `onboarding@resend.dev`. Enter a Resend API
key in Password, then check and save. This does not send a message.

The test sender can only deliver to the email associated with the Resend account, so it
cannot reach customers. To send reminders, verify a domain in Resend and choose a sender on it. Authentication success alone does not prove sender eligibility.

Sources: [Resend SMTP](https://resend.com/docs/send-with-smtp),
[test sender restriction](https://resend.com/docs/knowledge-base/403-error-resend-dev-domain).
