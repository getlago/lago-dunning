"""Manual, single-recipient delivery of one approved draft. No bulk or autonomous sending."""
import json
import smtplib
import ssl
import sys
from email.message import EmailMessage
from email.utils import make_msgid


def send(data):
    settings, draft = data['settings'], data['draft']
    recipient = draft.get('recipient')
    if not isinstance(recipient, str) or recipient.count('@') != 1 or any(c in recipient for c in '\r\n,;<> '):
        return {'accepted': False, 'attempted': False, 'message': 'The recipient could not be verified.'}
    if not settings.get('from') or any(c in settings['from'] for c in '\r\n') or any(c in draft['subject'] for c in '\r\n'):
        return {'accepted': False, 'attempted': False, 'message': 'The sender or subject is invalid.'}
    security, host = settings['security'], settings['host']
    if security not in ('none', 'tls', 'starttls') or (security == 'none' and (host not in ('localhost', '127.0.0.1') or settings.get('username'))):
        return {'accepted': False, 'attempted': False, 'message': 'SMTP security settings are invalid.'}
    smtp = None
    attempted = False
    try:
        message = EmailMessage()
        message['From'], message['To'], message['Subject'] = settings['from'], recipient, draft['subject']
        message['Message-ID'] = make_msgid()
        message.set_content(draft['body'])
        if draft.get('html'):
            message.add_alternative(draft['html'], subtype='html')
        context = ssl.create_default_context()
        smtp = smtplib.SMTP_SSL(host, settings['port'], timeout=10, context=context) if security == 'tls' else smtplib.SMTP(host, settings['port'], timeout=10)
        smtp.ehlo()
        if security == 'starttls':
            smtp.starttls(context=context)
            smtp.ehlo()
        if settings.get('username'):
            smtp.login(settings['username'], settings['password'])
        attempted = True
        refused = smtp.send_message(message, from_addr=settings['from'], to_addrs=[recipient])
        if refused:
            return {'accepted': False, 'attempted': False, 'message': 'SMTP refused the recipient.'}
        return {'accepted': True, 'messageId': str(message['Message-ID']), 'recipient': recipient}
    except (smtplib.SMTPRecipientsRefused, smtplib.SMTPSenderRefused, smtplib.SMTPDataError):
        return {'accepted': False, 'attempted': False, 'message': 'SMTP rejected the message. Check the sender and recipient configuration.'}
    except Exception:
        return {'accepted': False, 'attempted': attempted, 'message': 'SMTP did not confirm acceptance. Check the connection and review the draft status.'}
    finally:
        if smtp:
            try:
                smtp.quit()
            except Exception:
                smtp.close()


if __name__ == '__main__':
    print(json.dumps(send(json.load(sys.stdin))))
