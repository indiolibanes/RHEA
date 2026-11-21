import { DriveError } from '../drive-files.mjs';
import { decryptGoogle, encryptGoogle, random, secretValue, timestamp } from './security.mjs';

const scope = 'https://www.googleapis.com/auth/drive.file';
const refreshEndpoint = 'https://oauth2.googleapis.com/token';
const wait = () => new Promise(resolve => setTimeout(resolve, 200));
const storageAccount = account => account + ':rhea-drive-link';
const connectedUntilRevoked = 253402300799;
export const durableMarker = id => 'linked:' + id;
export const durableId = value => typeof value === 'string' && value.startsWith('linked:') &&
  secretValue(value.slice(7)) ? value.slice(7) : null;
export const durableExpiry = () => connectedUntilRevoked;

export function driveLinks(cfg, fetcher = fetch) {
  if (!cfg?.persistent) return null;
  const stmt = (sql, ...args) => cfg.db.prepare(sql).bind(...args);
  const lookup = actor => stmt('SELECT * FROM rhea_drive_links WHERE actor=?', actor).first();

  async function seal(actor, account, linkId, credential) {
    return encryptGoogle(cfg.secret, JSON.stringify(credential), actor, storageAccount(account), linkId);
  }
  async function read(row) {
    return JSON.parse(await decryptGoogle(cfg.secret, row.sealed, row.actor, storageAccount(row.account)));
  }

  async function connect(actor, session, refreshToken) {
    if (!cfg.google || typeof refreshToken !== 'string' || !refreshToken || refreshToken.length > 4096) return false;
    const previous = await lookup(actor);
    const linkId = previous?.account === session.account && previous.sealed ? previous.link_id : random();
    const value = await seal(actor, session.account, linkId, { token: session.token, refresh: refreshToken, name: session.name });
    const time = timestamp();
    const currentLink = 'EXISTS (SELECT 1 FROM rhea_drive_links WHERE actor=? AND account=? AND link_id=? AND sealed=?)';
    const results = await cfg.db.batch([
      stmt(`INSERT INTO rhea_drive_links(actor,account,link_id,sealed,access_expires,updated)
        VALUES(?,?,?,?,?,?) ON CONFLICT(actor) DO UPDATE SET account=excluded.account,link_id=excluded.link_id,
        sealed=excluded.sealed,access_expires=excluded.access_expires,renew_lock=NULL,renew_until=NULL,updated=excluded.updated
        WHERE rhea_drive_links.link_id IS ? AND rhea_drive_links.updated IS ?`,
      actor, session.account, linkId, value, session.exp, time, previous?.link_id ?? null, previous?.updated ?? null),
      stmt(`UPDATE oauth_grants SET revoked=? WHERE actor=? AND account<>? AND revoked IS NULL AND ${currentLink}`,
        time, actor, session.account, actor, session.account, linkId, value),
      stmt(`DELETE FROM oauth_requests WHERE actor=? AND account<>? AND ${currentLink}`,
        actor, session.account, actor, session.account, linkId, value),
    ]);
    return results[0].meta.changes === 1;
  }

  async function disconnect(actor) {
    const now = timestamp();
    await cfg.db.batch([
      stmt(`INSERT INTO rhea_drive_links(actor,updated) VALUES(?,?) ON CONFLICT(actor) DO UPDATE SET
        account=NULL,link_id=NULL,sealed=NULL,access_expires=NULL,renew_lock=NULL,renew_until=NULL,updated=excluded.updated`, actor, now),
      stmt('UPDATE oauth_grants SET revoked=? WHERE actor=? AND revoked IS NULL', now, actor),
      stmt('DELETE FROM oauth_requests WHERE actor=?', actor),
    ]);
  }

  async function expire(row, lock) {
    const now = timestamp();
    await cfg.db.batch([
      stmt(`UPDATE oauth_grants SET revoked=? WHERE actor=? AND account=? AND google=? AND revoked IS NULL
        AND EXISTS (SELECT 1 FROM rhea_drive_links WHERE actor=? AND link_id=? AND renew_lock=?)`,
      now, row.actor, row.account, durableMarker(row.link_id), row.actor, row.link_id, lock),
      stmt(`UPDATE rhea_drive_links SET sealed=NULL,access_expires=NULL,renew_lock=NULL,renew_until=NULL,updated=?
        WHERE actor=? AND link_id=? AND renew_lock=?`, now, row.actor, row.link_id, lock),
    ]);
  }

  async function renew(row, credential, lock) {
    try {
      const response = await fetcher(refreshEndpoint, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(12_000),
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: credential.refresh,
          client_id: cfg.google.clientId, client_secret: cfg.google.clientSecret }) })
        .catch(() => { throw new DriveError(503, 'O Google não renovou a sessão agora.', 'drive_refresh_unavailable'); });
      if (response.status >= 300 && response.status < 400) throw new DriveError(502, 'O Google redirecionou a renovação da sessão.');
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        if (payload?.error === 'invalid_grant') { await expire(row, lock); return null; }
        throw new DriveError(response.status === 429 ? 429 : 503, 'O Google não renovou a sessão agora.', 'drive_refresh_unavailable');
      }
      if (typeof payload?.access_token !== 'string' || !payload.access_token || payload.access_token.length > 4096 ||
          !Number.isFinite(payload.expires_in) || payload.expires_in < 60 ||
          (payload.scope != null && (typeof payload.scope !== 'string' || !payload.scope.split(/\s+/).includes(scope)))) {
        throw new DriveError(502, 'O Google retornou uma sessão inválida.');
      }
      const refreshed = { ...credential, token: payload.access_token };
      if (typeof payload.refresh_token === 'string' && payload.refresh_token && payload.refresh_token.length <= 4096) {
        refreshed.refresh = payload.refresh_token;
      }
      const exp = timestamp() + Math.min(3600, payload.expires_in - 30);
      const sealed = await seal(row.actor, row.account, row.link_id, refreshed);
      const updated = await stmt(`UPDATE rhea_drive_links SET sealed=?,access_expires=?,renew_lock=NULL,renew_until=NULL,updated=?
        WHERE actor=? AND link_id=? AND renew_lock=? RETURNING account`, sealed, exp, timestamp(), row.actor, row.link_id, lock).first();
      return updated ? { token: refreshed.token, exp, name: refreshed.name, account: row.account, linkId: row.link_id } : null;
    } finally {
      await stmt('UPDATE rhea_drive_links SET renew_lock=NULL,renew_until=NULL WHERE actor=? AND link_id=? AND renew_lock=?',
        row.actor, row.link_id, lock).run();
    }
  }

  async function session(actor, expectedAccount, expectedId) {
    if (!cfg.google) return { known: true, session: null };
    for (let attempt = 0; attempt < 5; attempt++) {
      const row = await lookup(actor);
      if (!row) return { known: false, session: null };
      if ((expectedAccount && row.account !== expectedAccount) || (expectedId && row.link_id !== expectedId)) {
        return { known: true, session: null };
      }
      if (!row.sealed) return { known: true, session: null, reauthorize: Boolean(row.link_id) };
      if (row.access_expires > timestamp() + 30) {
        const credential = await read(row);
        return { known: true, session: { token: credential.token, exp: row.access_expires, name: credential.name,
          account: row.account, linkId: row.link_id } };
      }
      const lock = random(), now = timestamp();
      const acquired = await stmt(`UPDATE rhea_drive_links SET renew_lock=?,renew_until=? WHERE actor=? AND link_id=?
        AND sealed IS NOT NULL AND access_expires<=? AND (renew_until IS NULL OR renew_until<=?) RETURNING *`,
      lock, now + 20, row.actor, row.link_id, now + 30, now).first();
      if (acquired) {
        let credential;
        try { credential = await read(acquired); }
        catch (error) {
          await stmt('UPDATE rhea_drive_links SET renew_lock=NULL,renew_until=NULL WHERE actor=? AND link_id=? AND renew_lock=?',
            actor, row.link_id, lock).run();
          throw error;
        }
        const renewed = await renew(acquired, credential, lock);
        if (renewed) return { known: true, session: renewed };
        // Renewal may have lost a race to a reconnect, disconnect or provider revocation.
        // Re-read before deciding which state to show.
        continue;
      }
      await wait();
    }
    throw new DriveError(503, 'A sessão Google está sendo renovada. Tente novamente em instantes.', 'drive_refresh_pending');
  }
  return { connect, disconnect, session };
}
