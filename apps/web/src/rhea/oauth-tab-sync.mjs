// Sends only fixed OAuth outcome codes between same-origin tabs. Credentials
// for persistent sessions stay in D1.
const RETURN_CODES = new Set([
  'connected', 'oauth_state', 'oauth_consent', 'oauth_client', 'oauth_redirect',
  'oauth_exchange', 'oauth_code', 'oauth_grant', 'oauth_request',
  'oauth_token_timeout', 'oauth_token_network', 'oauth_token_response', 'oauth_token_rejected', 'oauth_token_redirect',
  'oauth_scope', 'oauth_offline', 'oauth_link_changed', 'oauth_drive', 'erro',
]);
const CHANNEL_NAME = 'rhea-oauth';

export function oauthReturnCode(search) {
  if (typeof search !== 'string') return null;
  const codes = new URLSearchParams(search).getAll('drive');
  return codes.length === 1 && RETURN_CODES.has(codes[0]) ? codes[0] : null;
}

export function watchOAuthTabReturn({ win, doc, onReturn, makeChannel = name => new BroadcastChannel(name) }) {
  if (typeof onReturn !== 'function') throw new TypeError('onReturn must be a function');
  let channel;
  let closed = false;
  let lastFocus = 0;
  const notify = (code, reason) => {
    if (closed) return;
    if (reason === 'focus') {
      const current = Date.now();
      if (current - lastFocus < 750) return;
      lastFocus = current;
    }
    onReturn(code);
  };
  const onFocus = () => { if (!doc.hidden) notify(null, 'focus'); };
  win.addEventListener('focus', onFocus);
  doc.addEventListener('visibilitychange', onFocus);
  try {
    channel = makeChannel(CHANNEL_NAME);
    channel.addEventListener('message', event => {
      if (event.data?.type !== 'oauth-return' || !RETURN_CODES.has(event.data.code)) return;
      notify(event.data.code, 'channel');
    });
    const code = oauthReturnCode(win.location.search);
    if (code) channel.postMessage({ type: 'oauth-return', code });
  } catch {
    channel?.close?.();
    channel = undefined;
  }
  return () => {
    closed = true;
    win.removeEventListener('focus', onFocus);
    doc.removeEventListener('visibilitychange', onFocus);
    channel?.close?.();
  };
}
