import { createHash, randomBytes } from 'node:crypto';
import { open, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { FloodWaitError, SlowModeWaitError } from 'teleproto/errors';
import { forumId } from '../src/rhea/library/forum-contract.mjs';
import { mirrorLimit } from '../src/rhea/library/mirror-contract.mjs';
import { rebuildJournalLimit, rebuildLimit } from '../src/rhea/library/organization-contract.mjs';
import { MirrorPreflightError, mirrorUnits } from './mirror-messages.mjs';

const approvalTtl = 5 * 60_000;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const idsOf = unit => unit.map(post => post.id);
const fingerprint = posts => posts.map(({ id, parent, album, contents }) => [id, parent, album, contents]);

export function telegramWaitSeconds(error) {
  const seconds = Number(error?.seconds ?? /^FLOOD_WAIT_(\d+)$/.exec(error?.errorMessage ?? '')?.[1]);
  return Number.isInteger(seconds) && seconds > 0 && seconds <= 2_147_483_647 ? seconds : 0;
}

function readLog(lines, scope, dual, ordered, limit) {
  const [header, ...events] = lines;
  if (header?.type !== 'approved' || header.scope !== scope ||
      !/^[0-9a-f]{64}$/.test(header.evidence ?? '') || !Array.isArray(header.units) ||
      header.units.some(unit => !Array.isArray(unit) || !unit.length || unit.length > 10)) return null;
  const ids = header.units.flat();
  if (!ids.length || ids.length > limit || new Set(ids).size !== ids.length ||
      ids.some((id, i) => !forumId(id) || (!ordered && i && ids[i - 1] >= id))) return null;
  const copies = [];
  const localCopies = [];
  let step = 0;
  let intent;
  let receipt;
  let retryAt = 0;
  for (const event of events) {
    const local = dual && step < header.units.length;
    const unit = header.units[dual && !local ? step - header.units.length : step];
    if (!unit || event?.step !== step) return null;
    const targetCopies = local ? localCopies : copies;
    const last = targetCopies.at(-1)?.destinationId ?? 0;
    if (event.type === 'intent' && (!intent || retryAt) && Array.isArray(event.ids) && event.ids.length === unit.length &&
        (!intent || event.ids.every((id, i) => id === intent.ids[i])) &&
        new Set(event.ids).size === unit.length && event.ids.every(id => typeof id === 'string' && /^[1-9][0-9]{0,18}$/.test(id))) {
      intent = event;
      retryAt = 0;
    } else if (event.type === 'deferred' && intent && !receipt && !retryAt && Number.isSafeInteger(event.until) && event.until > 0) {
      retryAt = event.until;
    } else if (event.type === 'cooldown' && (!intent || receipt || retryAt) && Number.isSafeInteger(event.until) && event.until > retryAt) {
      retryAt = event.until;
    } else if (event.type === 'receipt' && intent && !receipt && !retryAt && Array.isArray(event.ids) && event.ids.length === unit.length &&
        event.ids.every((id, i) => forumId(id) && id > (i ? event.ids[i - 1] : last))) {
      receipt = event;
    } else if (event.type === 'verified' && receipt) {
      targetCopies.push(...receipt.ids.map((id, i) => ({ sourceId: unit[i], destinationId: id })));
      step++;
      intent = receipt = undefined;
      retryAt = 0;
    } else {
      return null;
    }
  }
  return { ...header, total: ids.length, step, copies, localCopies, intent, receipt, retryAt };
}

async function append(handle, event) {
  await handle.writeFile(JSON.stringify(event) + '\n');
  await handle.sync();
}

function verifyDestination(source, destination, mappings) {
  if (!destination || destination.length !== mappings.length || !mirrorUnits(destination)) return false;
  const parents = new Map(mappings.map(copy => [copy.sourceId, copy.destinationId]));
  const groups = new Map();
  for (let i = 0; i < mappings.length; i++) {
    const original = source[i];
    const copy = destination[i];
    if (!original || original.id !== mappings[i].sourceId || copy.id !== mappings[i].destinationId ||
        copy.parent !== (original.parent === null ? null : parents.get(original.parent)) ||
        digest(copy.contents) !== digest(original.contents) || (original.album === null) !== (copy.album === null)) return false;
    if (original.album !== null) {
      if (!groups.has(original.album)) groups.set(original.album, copy.album);
      if (groups.get(original.album) !== copy.album) return false;
    }
  }
  return new Set(groups.values()).size === groups.size;
}

export function mirrorControl(config, now = Date.now) {
  if (!config.mirror) return { handle: async () => ({ state: 'mirror_disabled' }), reset() {} };
  const { source, destination, local } = config.mirror;
  const { rebuild, intake, organization } = config.mirror;
  const ordered = organization ?? rebuild;
  const limit = rebuild ? rebuildLimit : mirrorLimit;
  const target = digest([destination.channelId, destination.topicId]);
  const scope = digest([config.actor, config.ownerId, source.channelId, source.topicId, target, ...(local ? [local.topicId] : []),
    ...(ordered ? [ordered.letter, ordered.ids] : []), ...(rebuild ? [intake.topicId, rebuild.beforeId] : []),
    ...(rebuild?.insertions ? [rebuild.insertions] : [])]);
  const journal = join(dirname(config.file), rebuild ? 'letter-rebuild-pilot.jsonl' :
    ordered ? 'organization-pilot.jsonl' : 'mirror-' + target + '.jsonl');
  const archive = scope => join(dirname(journal), 'letter-rebuild-' + scope + '.jsonl');
  let pending;
  let active = false;

  async function readJournalFile(path, expectedScope) {
    let file;
    try {
      file = await open(path, 'r');
      const { size } = await file.stat();
      if (size < 1 || size > (rebuild ? rebuildJournalLimit : 16384)) return false;
      const contents = await file.readFile('utf8');
      if (!contents.endsWith('\n')) return false;
      const lines = contents.trimEnd().split('\n').map(line => JSON.parse(line));
      const recordedScope = lines[0]?.scope;
      if (!/^[a-f0-9]{64}$/.test(recordedScope ?? '')) return false;
      return readLog(lines, expectedScope ?? recordedScope, Boolean(local), Boolean(ordered), limit) ?? false;
    } catch (error) {
      return error.code === 'ENOENT' ? null : false;
    } finally {
      await file?.close();
    }
  }

  async function readJournal() {
    const current = await readJournalFile(journal, rebuild ? undefined : scope);
    if (!rebuild || current === false || current?.scope === scope) return current;
    const saved = await readJournalFile(archive(scope), scope);
    if (saved !== null) return saved;
    if (current && status(current).state !== 'mirror_done') return false;
    return null;
  }

  function status(log) {
    if (log === null) return { state: 'mirror_idle' };
    if (!log) return { state: 'mirror_recovery' };
    const state = log.copies.length === log.total ? 'mirror_done' :
      log.intent && !log.receipt && !log.retryAt ? 'mirror_recovery' : 'mirror_progress';
    return progress(state, log);
  }

  function progress(state, log) {
    return { state, mirror: { total: log.total, copies: log.copies, ...(local && { localCopies: log.localCopies }) } };
  }

  async function inspect(client) {
    const transport = ordered ? await client.organize(config.mirror) : await client.mirror();
    if (!transport) throw new MirrorPreflightError('account', 'account_unverified');
    const posts = await transport.readSource();
    if (!posts) throw new MirrorPreflightError('source', 'history_unverified');
    if (!posts.length) throw new MirrorPreflightError('source', 'source_empty');
    const units = mirrorUnits(posts);
    if (!units) throw new MirrorPreflightError('source', 'album_or_reply');
    if (Boolean(transport.local) !== Boolean(local)) throw new MirrorPreflightError('local', 'history_unverified');
    const revision = transport.sourceRevision;
    const evidence = digest([scope, transport.sourceTitle, transport.destinationTitle,
      ...(local ? [transport.local.title] : []), fingerprint(posts), ...(ordered ? [revision] : [])]);
    return { transport, posts, units, evidence, revision };
  }

  async function approve(preview, plan) {
    let file;
    try {
      if (rebuild) {
        const previous = await readJournalFile(journal);
        if (previous !== null) {
          if (!previous || previous.scope === scope || status(previous).state !== 'mirror_done') return { state: 'mirror_recovery' };
          await rename(journal, archive(previous.scope));
        }
      }
      file = await open(journal, 'wx', 0o600);
      await append(file, { type: 'approved', scope, evidence: plan.evidence, units: plan.units.map(idsOf), at: now(),
        approval: digest(preview.approval) });
      const directory = await open(dirname(journal), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
      return progress('mirror_progress', { total: plan.posts.length, copies: [], localCopies: [] });
    } catch {
      return { state: 'mirror_recovery' };
    } finally {
      await file?.close();
    }
  }

  async function next(log, plan) {
    const { transport, posts, units } = plan;
    const step = log.step;
    const onLocal = local && step < units.length;
    const unit = units[local && !onLocal ? step - units.length : step];
    const read = onLocal ? transport.local.read : transport.readDestination;
    const copy = onLocal ? transport.local.copy : transport.copy;
    const verified = onLocal ? log.localCopies : log.copies;
    const received = log.receipt?.ids.map((id, i) => ({ sourceId: unit[i].id, destinationId: id }));
    const mappings = received ? [...verified, ...received] : verified;
    const otherMatches = async () => {
      if (!local) return true;
      const other = onLocal ? await transport.readDestination() : await transport.local.read();
      return verifyDestination(posts, other, onLocal ? log.copies : log.localCopies);
    };
    const current = await read();
    if (!verifyDestination(posts, current, mappings) || !await otherMatches()) return { state: 'mirror_changed' };

    const file = await open(journal, 'a');
    try {
      if (received) {
        if (!local && !ordered && !await transport.verifyMedia(current.slice(verified.length))) return { state: 'mirror_changed' };
        // Ordered runs verify metadata without downloading. Intermediate receipts already have fresh
        // source and destination snapshots. Keep a second pass at completion and after media probes.
        if (!ordered || step + 1 === units.length * (local ? 2 : 1)) {
          if (!verifyDestination(posts, await read(), mappings) || !await otherMatches()) return { state: 'mirror_changed' };
          const latest = await transport.readSource();
          if (!latest || digest(fingerprint(latest)) !== digest(fingerprint(posts)) ||
              (ordered && digest(transport.sourceRevision) !== digest(plan.revision))) return { state: 'mirror_changed' };
        }
        await append(file, { type: 'verified', step });
        return status({ ...log, intent: undefined, receipt: undefined, ...(onLocal ? { localCopies: mappings } : { copies: mappings }) });
      }
      const targetParent = unit[0].parent === null ? null : verified.find(item => item.sourceId === unit[0].parent)?.destinationId;
      if (targetParent === undefined) return { state: 'mirror_changed' };
      const ids = log.intent ? log.intent.ids.map(id => BigInt(id)) : unit.map(() => (randomBytes(8).readBigUInt64BE() >> 1n) || 1n);
      await append(file, { type: 'intent', step, ids: ids.map(String) });
      let receipt;
      try {
        receipt = await copy(unit, ids, targetParent);
      } catch (error) {
        // An explicit RPC rejection permits a retry with the same Telegram random IDs.
        // A missing response leaves the intent pending for manual recovery.
        if ((error instanceof FloodWaitError || error instanceof SlowModeWaitError) &&
            Number.isInteger(error.seconds) && error.seconds > 0) {
          await append(file, { type: 'deferred', step, until: now() + error.seconds * 1000 });
        }
        throw error;
      }
      const last = verified.at(-1)?.destinationId ?? 0;
      if (!Array.isArray(receipt) || receipt.length !== unit.length ||
          receipt.some((id, i) => !forumId(id) || id <= (i ? receipt[i - 1] : last))) {
        return progress('mirror_recovery', log);
      }
      await append(file, { type: 'receipt', step, ids: receipt });
      return status(log);
    } finally {
      await file.close();
    }
  }

  async function handle(operation, input, client) {
    if (active) return { state: 'busy' };
    active = true;
    let advancing = false;
    try {
      const previous = await readJournal();
      const result = status(previous);
      const retryAt = previous?.retryAt;
      const time = now();
      if ((operation === 'mirrorstatus' || operation === 'mirrornext') && retryAt > time) {
        return { state: 'rate_limited', retryAt, retryAfter: Math.ceil((retryAt - time) / 1000) };
      }
      if (operation === 'mirrorstatus' || !['mirror_idle', 'mirror_progress'].includes(result.state)) return result;
      if (operation === 'mirrornext') {
        if (!previous) return result;
        advancing = Boolean(ordered);
        const plan = await inspect(client);
        if (plan.evidence !== previous.evidence ||
            digest(plan.units.map(idsOf)) !== digest(previous.units)) return { state: 'mirror_changed' };
        return await next(previous, plan);
      }
      if (previous) return result;

      const approval = pending;
      pending = undefined;
      if (operation === 'mirrorapprove' && (!approval || input.confirm !== true ||
          approval.approval !== input.approval || approval.expiresAt <= now())) return { state: 'mirror_changed' };
      const plan = await inspect(client);
      const target = await plan.transport.readDestination({ requireEmpty: true });
      if (!target) throw new MirrorPreflightError('destination', 'history_unverified');
      if (target.length) throw new MirrorPreflightError('destination', 'destination_not_empty');
      if (local) {
        const organized = await plan.transport.local.read({ requireEmpty: true });
        if (!organized) throw new MirrorPreflightError('local', 'history_unverified');
        if (organized.length) throw new MirrorPreflightError('local', 'destination_not_empty');
      }
      if (operation === 'mirrorapprove') {
        return plan.evidence === approval.evidence && approval.expiresAt > now()
          ? await approve(approval, plan) : { state: 'mirror_changed' };
      }
      pending = { approval: randomBytes(32).toString('base64url'), expiresAt: now() + approvalTtl, evidence: plan.evidence };
      return { state: 'mirror_preview', mirror: { approval: pending.approval, expiresAt: pending.expiresAt,
        total: plan.posts.length, source: plan.transport.sourceTitle, destination: plan.transport.destinationTitle,
        ...(local && { localDestination: plan.transport.local.title }),
        posts: plan.posts.map(({ id, contents, message }) => ({ id, kind: contents.kind,
          label: message.entities?.some(entity => entity.className === 'MessageEntitySpoiler') ? '' : contents.filename || contents.text })) } };
    } catch (error) {
      const seconds = telegramWaitSeconds(error);
      if (advancing && seconds) {
        const latest = await readJournal();
        const checkpoint = status(latest);
        if (checkpoint.state !== 'mirror_progress') return checkpoint;
        const time = now();
        const retryAt = latest.retryAt > time ? latest.retryAt : time + seconds * 1000;
        if (retryAt !== latest.retryAt) {
          const file = await open(journal, 'a');
          try { await append(file, { type: 'cooldown', step: latest.step, until: retryAt }); }
          finally { await file.close(); }
        }
        return { state: 'rate_limited', retryAt, retryAfter: Math.ceil((retryAt - time) / 1000) };
      }
      if (!(error instanceof MirrorPreflightError)) throw error;
      return { state: operation === 'mirrorpreview' ? 'mirror_ineligible' : 'mirror_changed', issue: error.issue };
    } finally {
      active = false;
    }
  }

  return { handle, reset() { pending = undefined; } };
}
