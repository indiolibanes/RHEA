import { durableExpiry, durableId, durableMarker } from './drive-link.mjs';
import { digest, encryptGoogle, proofDigest, random, secretValue, timestamp } from './security.mjs';

const accessLifetime = 300;
const refreshRetryWindow = 15;

export function storage(config) {
  const statement = (sql, ...args) => config.db.prepare(sql).bind(...args);
  const first = (sql, ...args) => statement(sql, ...args).first();
  const run = (sql, ...args) => statement(sql, ...args).run();
  const all = async (sql, ...args) => (await statement(sql, ...args).all()).results;

  async function rate(key, limit, seconds = 60) {
    const time = timestamp();
    const period = Math.floor(time / seconds);
    const row = await first(`INSERT INTO rhea_rate(key, expires, hits) VALUES(?, ?, 1)
      ON CONFLICT(key) DO UPDATE SET hits = hits + 1 RETURNING hits`, await digest(config.secret + ':' + key + ':' + period), (period + 2) * seconds);
    return row?.hits <= limit;
  }

  async function request(client, redirect, state, challenge, scope) {
    const id = random();
    await run('INSERT INTO oauth_requests(id,client,redirect,state,challenge,scope,expires) VALUES(?,?,?,?,?,?,?)',
      id, client, redirect, state, challenge, scope, timestamp() + 600);
    return id;
  }

  function pending(id) {
    if (!secretValue(id)) return null;
    return first('SELECT id,client,scope,redirect FROM oauth_requests WHERE id=? AND code IS NULL AND expires>?', id, timestamp());
  }

  async function approve(id, actor, session, accepted, scope) {
    if (!secretValue(id)) return null;
    const code = random();
    const time = timestamp();
    const durable = accepted && Boolean(session.linkId);
    const encrypted = !accepted ? null : durable ? durableMarker(session.linkId) :
      await encryptGoogle(config.secret, session.token, actor, session.account, id);
    const result = await first(`UPDATE oauth_requests SET actor=?,account=?,google=?,google_expires=?,code=?,expires=?,scope=COALESCE(?,scope)
      WHERE id=? AND code IS NULL AND expires>? RETURNING redirect,state,client`,
      actor, accepted ? session.account : null, encrypted, !accepted ? null : durable ? durableExpiry() : session.exp,
      await digest(code), time + 90, scope ?? null,
      id, time);
    if (!result) return null;
    const callback = new URL(result.redirect);
    callback.searchParams.set('state', result.state);
    callback.searchParams.set('iss', config.origin);
    if (accepted) callback.searchParams.set('code', code);
    else callback.searchParams.set('error', 'access_denied');
    return { callback: callback.href, client: result.client };
  }

  const matchingLink = grant => first('SELECT link_id FROM rhea_drive_links WHERE actor=? AND account=? AND link_id=? AND sealed IS NOT NULL',
    grant.actor, grant.account, durableId(grant.google));
  async function validLink(grant) {
    if (!durableId(grant.google)) return true;
    if (config.persistent && !config.google) throw new Error('Persistent Drive configuration is incomplete');
    return Boolean(config.google && await matchingLink(grant));
  }

  function tokenResponse(access, refresh, expiry, scope) {
    return { access_token: access, token_type: 'Bearer', expires_in: Math.max(1, expiry - timestamp()),
      refresh_token: refresh, scope };
  }

  async function issue(grant) {
    if (!await validLink(grant)) return null;
    const access = random(), refresh = random();
    const time = timestamp();
    const accessExpiry = Math.min(time + accessLifetime, grant.expires);
    if (accessExpiry <= time) return null;
    await config.db.batch([
      statement(`INSERT INTO oauth_grants(id,actor,account,client,resource,scope,google,expires) VALUES(?,?,?,?,?,?,?,?)`,
        grant.id, grant.actor, grant.account, grant.client, config.resource, grant.scope, grant.google, grant.expires),
      statement("INSERT INTO oauth_tokens(hash,grant_id,kind,expires) VALUES(?,?,'access',?)",
        await digest(access), grant.id, accessExpiry),
      statement("INSERT INTO oauth_tokens(hash,grant_id,kind,expires) VALUES(?,?,'refresh',?)",
        await digest(refresh), grant.id, grant.expires),
    ]);
    return tokenResponse(access, refresh, accessExpiry, grant.scope);
  }

  async function exchange(code, client, redirect, challenge) {
    if (!secretValue(code)) return null;
    const time = timestamp();
    const hash = await digest(code);
    const approved = await first(`UPDATE oauth_requests SET consumed=?, google=NULL
      WHERE code=? AND client=? AND redirect=? AND challenge=? AND expires>? AND google_expires>? AND consumed IS NULL
      RETURNING id,actor,account,client,scope,google_expires`, time, hash, client, redirect, challenge, time, time);
    // The credential is read before consumption and the conditional UPDATE decides the sole winner.
    if (!approved) return null;
    return approved;
  }

  async function authorizationCode(code, client, redirect, challenge) {
    if (!secretValue(code)) return null;
    const existing = await first('SELECT actor,account,google FROM oauth_requests WHERE code=? AND client=? AND consumed IS NULL',
      await digest(code), client);
    if (!existing?.google || !await validLink(existing)) return null;
    const approved = await exchange(code, client, redirect, challenge);
    if (!approved) return null;
    return issue({ ...approved, id: random(), google: existing.google, expires: approved.google_expires });
  }

  const grantBy = (hash, kind) => first(`SELECT g.*, t.consumed, t.expires AS token_expires
    ${config.google ? ', t.scope AS token_scope' : ''}
    FROM oauth_tokens t JOIN oauth_grants g ON t.grant_id=g.id WHERE t.hash=? AND t.kind=? AND g.resource=?`,
    hash, kind, config.resource);

  async function renew(token, client, requestedScope) {
    if (!secretValue(token)) return null;
    const hash = await digest(token);
    let grant = await grantBy(hash, 'refresh');
    const time = timestamp();
    if (!grant || grant.client !== client || grant.revoked != null || grant.expires <= time || grant.token_expires <= time ||
        (requestedScope && (!config.google ? requestedScope !== grant.scope :
          requestedScope.split(' ').some(scope => !grant.scope.split(' ').includes(scope)))) || !await validLink(grant)) return null;
    const accessScope = requestedScope ?? grant.scope;
    const rotation = kind => proofDigest(config.secret, JSON.stringify(['rhea-refresh-rotation', kind, config.resource, client, grant.id, token]));
    // A short retry window can reproduce the same pair without storing bearer credentials.
    const [access, refresh] = await Promise.all([rotation('access'), rotation('refresh')]);
    const [accessHash, refreshHash] = await Promise.all([digest(access), digest(refresh)]);
    if (grant.consumed == null) {
      const expiry = Math.min(time + accessLifetime, grant.expires);
      const eligible = `FROM oauth_tokens t JOIN oauth_grants g ON t.grant_id=g.id
        WHERE t.hash=? AND t.grant_id=? AND t.consumed IS NULL AND t.expires>? AND g.revoked IS NULL`;
      const filter = [hash, grant.id, time];
      const scoped = accessScope !== grant.scope;
      // D1 runs the batch as one transaction. Insert before marking the source consumed so only
      // the winning transaction creates credentials, even when requests have identical timestamps.
      const results = await config.db.batch([
        statement(`INSERT INTO oauth_tokens(hash,grant_id,kind,expires${scoped ? ',scope' : ''})
          SELECT ?,t.grant_id,'access',?${scoped ? ',?' : ''} ${eligible}`,
        accessHash, expiry, ...(scoped ? [accessScope] : []), ...filter),
        statement(`INSERT INTO oauth_tokens(hash,grant_id,kind,expires) SELECT ?,t.grant_id,'refresh',g.expires ${eligible}`,
          refreshHash, ...filter),
        statement(`UPDATE oauth_tokens SET consumed=? WHERE hash IN (SELECT t.hash ${eligible})`, time, ...filter),
      ]);
      if (results[2].meta.changes === 1) return tokenResponse(access, refresh, expiry, accessScope);
      grant = await grantBy(hash, 'refresh');
    }
    if (!grant || grant.revoked != null || grant.consumed == null) return null;
    if (timestamp() - grant.consumed >= refreshRetryWindow) {
      await run('UPDATE oauth_grants SET revoked=? WHERE id=? AND revoked IS NULL', time, grant.id);
      return null;
    }
    const [issuedAccess, issuedRefresh] = await Promise.all([grantBy(accessHash, 'access'), grantBy(refreshHash, 'refresh')]);
    if (issuedAccess?.id !== grant.id || issuedRefresh?.id !== grant.id || issuedAccess.revoked != null ||
        issuedRefresh.consumed != null || (issuedAccess.token_scope ?? issuedAccess.scope) !== accessScope ||
        issuedAccess.token_expires <= timestamp() || !await validLink(issuedAccess)) return null;
    return tokenResponse(access, refresh, issuedAccess.token_expires, accessScope);
  }

  async function access(token) {
    if (!secretValue(token)) return null;
    const grant = await grantBy(await digest(token), 'access');
    const time = timestamp();
    if (!grant || grant.revoked != null || grant.resource !== config.resource || grant.expires <= time ||
        grant.token_expires <= time || !config.clients.has(grant.client) || !grant.actor || !grant.account) return null;
    return await validLink(grant) ? { ...grant, scope: grant.token_scope ?? grant.scope } : null;
  }

  async function revokeToken(token, client) {
    if (!secretValue(token)) return;
    await run(`UPDATE oauth_grants SET revoked=? WHERE client=? AND revoked IS NULL AND id IN
      (SELECT grant_id FROM oauth_tokens WHERE hash=?)`, timestamp(), client, await digest(token));
  }

  async function disconnectActor(actor) {
    await config.db.batch([
      statement('UPDATE oauth_grants SET revoked=? WHERE actor=? AND revoked IS NULL', timestamp(), actor),
      statement('DELETE FROM oauth_requests WHERE actor=?', actor),
    ]);
  }

  function revokeActor(id, actor) {
    if (!secretValue(id)) return null;
    return first('UPDATE oauth_grants SET revoked=? WHERE id=? AND actor=? AND revoked IS NULL RETURNING client',
      timestamp(), id, actor);
  }

  function grants(actor) {
    return all('SELECT id,client,scope,expires,google FROM oauth_grants WHERE actor=? AND revoked IS NULL AND expires>? ORDER BY expires DESC LIMIT 20',
      actor, timestamp());
  }

  function audit({ actor = null, client, action, result }) {
    return run('INSERT INTO rhea_audit(id,actor,client,action,result,created) VALUES(?,?,?,?,?,?)',
      random(), actor, client, action, result, timestamp());
  }

  async function cleanup() {
    const time = timestamp();
    await config.db.batch([
      statement('DELETE FROM oauth_requests WHERE expires < ?', time),
      statement('DELETE FROM oauth_tokens WHERE grant_id IN (SELECT id FROM oauth_grants WHERE expires < ? OR revoked IS NOT NULL)', time),
      statement('DELETE FROM oauth_grants WHERE expires < ? OR revoked IS NOT NULL', time),
      statement("DELETE FROM oauth_tokens WHERE (kind='access' AND expires < ?) OR (kind='refresh' AND consumed < ?)", time, time - 30 * 86_400),
      statement('DELETE FROM rhea_rate WHERE expires < ?', time),
      statement('DELETE FROM rhea_audit WHERE created < ?', time - 30 * 86_400),
    ]);
  }

  return { rate, request, pending, approve, authorizationCode, renew, access, revokeToken, revokeActor, disconnectActor, grants, audit, cleanup };
}
