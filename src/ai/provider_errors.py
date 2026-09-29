"""Translate provider failures without exposing provider response bodies or credentials."""


def provider_error(error, operation=None, provider='bedrock'):
    def result(code, message, status=502):
        return {'error': code, 'message': message, 'status': status}

    if operation == 'send':
        return result('email_delivery_failed', 'The email server could not confirm delivery. Check the sender connection before retrying.')

    body = getattr(error, 'body', None) or getattr(error, 'response', {})
    detail = body.get('Error', body) if isinstance(body, dict) else {}
    if not isinstance(detail, dict):
        detail = {}
    # Raw text is used only for classification. Never return it, even as a fallback.
    text = str(detail.get('Message', detail.get('message', body if isinstance(body, str) else ''))).lower()
    code = str(detail.get('Code', detail.get('type', ''))).lower()
    status = getattr(error, 'status_code', None)
    name = type(error).__name__

    if provider == 'bedrock' and ('data retention' in text or 'data_retention' in text):
        return result('model_retention_policy', 'This model is blocked by your AWS data-retention policy. Choose another model, or ask your AWS administrator to review its retention requirements.', 422)
    if status == 429 or 'throttl' in code or 'too_many_requests' in code:
        return result('model_rate_limited', 'The AI provider is limiting requests. Wait a moment and try again.', 429)
    if 'expired' in code or ('token' in text and 'expired' in text):
        return result('model_credentials_expired', 'The AI connection has expired. Renew its credentials on the server.', 503)
    if status == 401 or code in ('unrecognizedclientexception', 'invalidsignatureexception'):
        return result('model_authentication_failed', 'The AI provider did not accept the server credentials. Check the AI connection.', 503)
    if status == 403 or 'accessdenied' in code:
        return result('model_access_denied', 'This AI connection does not have permission to use the selected model. Choose another model or have an administrator enable access.', 422)
    if status == 404 or 'resourcenotfound' in code:
        return result('model_not_found', 'This model or inference profile was not found in the configured region. Choose another model or check its ID.', 422)
    if any(term in text for term in ('toolconfig', 'tool_config', 'tool use', 'tool use is', 'tool calling', 'function calling')):
        return result('model_tools_unsupported', 'This model could not accept the agent’s tools. Choose another model that supports tool calling.', 422)
    if 'on-demand throughput' in text or 'inference profile' in text:
        return result('model_profile_required', 'Use an inference profile for this model instead of its base model ID.', 422)
    if status == 400 or 'validation' in code:
        return result('model_request_rejected', 'The AI provider rejected the request for this model. Try another model or check its supported settings.', 422)
    if name in ('EndpointConnectionError', 'ConnectTimeoutError', 'ReadTimeoutError', 'ConnectionError', 'TimeoutError'):
        return result('model_connection_failed', 'The app could not reach the AI provider. Check the connection and try again.', 503)
    if isinstance(status, int) and status >= 500:
        return result('model_service_unavailable', 'The AI provider is temporarily unavailable. Try again shortly.', 503)
    return result('model_request_failed', 'The assistant could not complete this request. Try again; if it persists, check the server’s AI setup.')
