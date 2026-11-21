import { durableId } from './drive-link.mjs';
import { proposals } from './proposals.mjs';
import { acceptsRedirect, configuration, digest, proofDigest, secretValue, timestamp } from './security.mjs';
import { storage } from './storage.mjs';

const proofFor = (cfg, id, actor, session) => proofDigest(cfg.secret, JSON.stringify(['private-consent', id, actor, session?.account ?? '', session?.linkId ?? '']));
const comparable = value => typeof value === 'string' && secretValue(value);

export function privateMcp(env, origin) {
  const cfg = configuration(env);
  if (!cfg || cfg.approval !== origin) return null;
  const db = storage(cfg);
  const clientLabel = id => cfg.clients.get(id)?.label;
  const actorTag = actor => digest(cfg.secret + ':audit:' + actor);

  async function review(id, actor, session) {
    const pending = await db.pending(id);
    const label = clientLabel(pending?.client);
    if (!label) return null;
    const canOrganize = Boolean(cfg.google && session?.linkId && cfg.clients.get(pending.client)?.organize);
    return { id, client: label, scope: pending.scope, canOrganize, account: session?.name ?? null,
      proof: await proofFor(cfg, id, actor, session) };
  }

  async function approve(input, actor, session) {
    const { id, accepted, proof, organize } = input ?? {};
    if (typeof accepted !== 'boolean' || !comparable(proof)) return null;
    const pending = await db.pending(id);
    if (!pending || !clientLabel(pending.client) || !acceptsRedirect(cfg.clients.get(pending.client), pending.redirect) ||
        proof !== await proofFor(cfg, id, actor, session)) return null;
    if (accepted && (!session?.token || typeof session.account !== 'string' || session.exp <= timestamp() + 30)) {
      return { reconnect: true };
    }
    if (accepted && organize === true && (!cfg.google || !session?.linkId || !cfg.clients.get(pending.client)?.organize)) return null;
    const approvedScope = organize === true ? 'rhea:read rhea:organize' :
      pending.scope.includes('rhea:propose') ? 'rhea:read rhea:propose' : 'rhea:read';
    const result = await db.approve(id, actor, session, accepted, approvedScope);
    if (result) await db.audit({ actor: await actorTag(actor), client: result.client,
      action: 'oauth_user_review', result: !accepted ? 'denied' : organize === true ? 'approved_organization' : 'approved' });
    return result ? { callback: result.callback } : null;
  }

  async function revoke(id, actor) {
    const result = await db.revokeActor(id, actor);
    if (result) await db.audit({ actor: await actorTag(actor), client: result.client, action: 'oauth_revoke', result: 'revoked' });
    return Boolean(result);
  }

  async function grants(actor) {
    return (await db.grants(actor)).map(({ id, client, scope, expires, google }) => ({
      id, client: clientLabel(client) ?? 'RHEA', provider: cfg.clients.get(client)?.provider, scope, expires,
      persistent: Boolean(durableId(google)),
    }));
  }
  return { endpoint: cfg.resource, review, approve, revoke, grants, proposals: proposals(cfg) };
}
