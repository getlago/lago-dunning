"""Check SMTP without issuing MAIL, RCPT or DATA: never submits an email."""
import json
import smtplib
import ssl
import sys


def verify(data):
    host, port, security = data['host'], int(data['port']), data['security']
    if security not in ('tls', 'starttls', 'none'):
        raise ValueError('Invalid security mode')
    if security == 'none' and (host not in ('localhost', '127.0.0.1') or data.get('username')):
        raise ValueError('Insecure SMTP')
    context = ssl.create_default_context()
    smtp = smtplib.SMTP_SSL(host, port, timeout=8, context=context) if security == 'tls' else smtplib.SMTP(host, port, timeout=8)
    try:
        code, _ = smtp.ehlo()
        if code != 250:
            raise smtplib.SMTPException('SMTP greeting rejected')
        if security == 'starttls':
            smtp.starttls(context=context)
            smtp.ehlo()
        if data.get('username'):
            smtp.login(data['username'], data['password'])
        code, _ = smtp.noop()
        if code != 250:
            raise smtplib.SMTPException('SMTP check rejected')
        return {'verified': True}
    finally:
        try:
            smtp.quit()
        except Exception:
            smtp.close()


if __name__ == '__main__':
    try:
        print(json.dumps(verify(json.load(sys.stdin))))
    except Exception as error:
        message = 'SMTP could not connect. Check the host, port and security settings.'
        if isinstance(error, smtplib.SMTPAuthenticationError):
            message = 'SMTP authentication failed. Check the username and password.'
        elif isinstance(error, (ssl.SSLError, smtplib.SMTPNotSupportedError)):
            message = 'SMTP TLS verification failed. Check the server certificate and security settings.'
        print(json.dumps({'verified': False, 'message': message}))
        sys.exit(1)
