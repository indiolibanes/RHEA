// Only fixed, locally controlled categories may reach redirects, logs or UI.
// Never expose Google's error_description, token response, OAuth code or verifier.
const TOKEN_FAILURES = Object.freeze({
  invalid_client: 'oauth_client',
  unauthorized_client: 'oauth_client',
  invalid_grant: 'oauth_grant',
  redirect_uri_mismatch: 'oauth_redirect',
  invalid_request: 'oauth_request',
  unsupported_grant_type: 'oauth_request',
});

export function tokenFailureCode(providerError) {
  return typeof providerError === 'string' && Object.hasOwn(TOKEN_FAILURES, providerError)
    ? TOKEN_FAILURES[providerError] : 'oauth_token_rejected';
}

export function tokenTransportFailure(error) {
  const name = error && typeof error === 'object' ? error.name : null;
  return name === 'TimeoutError' || name === 'AbortError'
    ? 'oauth_token_timeout' : 'oauth_token_network';
}
