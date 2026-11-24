import { createHash, randomBytes } from 'node:crypto';
import { open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { forumId } from '../src/rhea/library/forum-contract.mjs';
import { mirrorLimit } from '../src/rhea/library/mirror-contract.mjs';
import { MirrorPreflightError, mirrorUnits } from './mirror-messages.mjs';

const approvalTtl = 5 * 60_000;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const idsOf = unit => unit.map(post => post.id);
const fingerprint = posts => posts.map(({ id, parent, album, contents }) => [id, parent, album, contents]);

function readLog(lines, scope) {
  const [header, ...events] = lines;
  if (header?.type !== 'approved' || header.scope !== scope ||
      !/^[0-9a-f]{64}$/.test(header.evidence ?? '') || !Array.isArray(header.units) ||
      header.units.some(unit => !Array.isArray(unit) || !unit.length || unit.length > 10)) return null;
  const ids = header.units.flat();
  if (!ids.length || ids.length > mirrorLimit || ids.some((id, i) => !forumId(id) || (i && ids[i - 1] >= id))) return null;
  const copies = [];
  let step = 0;
  let intent;
  let receipt;
  for (const event of events) {
    const unit = header.units[step];
    if (!unit || event?.step !== step) return null;
    const last = copies.at(-1)?.destinationId ?? 0;
    if (event.type === 'intent' && !intent && Array.isArray(event.ids) && event.ids.length === unit.length &&
        new Set(event.ids).size === unit.length && event.ids.every(id => typeof id === 'string' && /^[1-9][0-9]{0,18}$/.test(id))) {
      intent = event;
    } else if (event.type === 'receipt' && intent && !receipt && Array.isArray(event.ids) && event.ids.length === unit.length &&
        event.ids.every((id, i) => forumId(id) && id > (i ? event.ids[i - 1] : last))) {
      receipt = event;
    } else if (event.type === 'verified' && receipt) {
      copies.push(...receipt.ids.map((id, i) => ({ sourceId: unit[i], destinationId: id })));
      step++;
      intent = receipt = undefined;
    } else {
      return null;
    }
  }
  return { ...header, total: ids.length, step, copies, intent, receipt };
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
  const { source, destination } = config.mirror;
  const target = digest([destination.channelId, destination.topicId]);
  const scope = digest([config.actor, config.ownerId, source.channelId, source.topicId, target]);
  const journal = join(dirname(config.file), 'mirror-' + target + '.jsonl');
  let pending;
  let active = false;

  async function readJournal() {
    let file;
    try {
      file = await open(journal, 'r');
      const { size } = await file.stat();
      if (size < 1 || size > 16384) return false;
      const contents = await file.readFile('utf8');
      if (!contents.endsWith('\n')) return false;
      return readLog(contents.trimEnd().split('\n').map(line => JSON.parse(line)), scope) ?? false;
    } catch (error) {
      return error.code === 'ENOENT' ? null : false;
    } finally {
      await file?.close();
    }
  }

  function status(log) {
    if (log === null) return { state: 'mirror_idle' };
    if (!log) return { state: 'mirror_recovery' };
    const state = log.copies.length === log.total ? 'mirror_done' :
      log.intent && !log.receipt ? 'mirror_recovery' : 'mirror_progress';
    return { state, mirror: { total: log.total, copies: log.copies } };
  }

  async function inspect(client) {
    const transport = await client.mirror();
    if (!transport) throw new MirrorPreflightError('account', 'account_unverified');
    const posts = await transport.readSource();
    if (!posts) throw new MirrorPreflightError('source', 'history_unverified');
    if (!posts.length) throw new MirrorPreflightError('source', 'source_empty');
    const units = mirrorUnits(posts);
    if (!units) throw new MirrorPreflightError('source', 'album_or_reply');
    const evidence = digest([scope, transport.sourceTitle, transport.destinationTitle, fingerprint(posts)]);
    return { transport, posts, units, evidence };
  }

  async function approve(preview, plan) {
    let file;
    try {
      file = await open(journal, 'wx', 0o600);
      await append(file, { type: 'approved', scope, evidence: plan.evidence, units: plan.units.map(idsOf), at: now(),
        approval: digest(preview.approval) });
      const directory = await open(dirname(journal), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
      return { state: 'mirror_progress', mirror: { total: plan.posts.length, copies: [] } };
    } catch {
      return { state: 'mirror_recovery' };
    } finally {
      await file?.close();
    }
  }

  async function next(log, plan) {
    const { transport, posts, units } = plan;
    const step = log.step;
    const unit = units[step];
    const current = await transport.readDestination();
    const received = log.receipt?.ids.map((id, i) => ({ sourceId: unit[i].id, destinationId: id }));
    const mappings = received ? [...log.copies, ...received] : log.copies;
    if (!verifyDestination(posts, current, mappings)) return { state: 'mirror_changed' };

    const file = await open(journal, 'a');
    try {
      if (received) {
        if (!await transport.verifyMedia(current.slice(log.copies.length)) ||
            !verifyDestination(posts, await transport.readDestination(), mappings)) return { state: 'mirror_changed' };
        const latest = await transport.readSource();
        if (!latest || digest(fingerprint(latest)) !== digest(fingerprint(posts))) return { state: 'mirror_changed' };
        await append(file, { type: 'verified', step });
        return status({ total: log.total, copies: mappings });
      }
      const targetParent = unit[0].parent === null ? null : log.copies.find(copy => copy.sourceId === unit[0].parent)?.destinationId;
      if (targetParent === undefined) return { state: 'mirror_changed' };
      const ids = unit.map(() => (randomBytes(8).readBigUInt64BE() >> 1n) || 1n);
      await append(file, { type: 'intent', step, ids: ids.map(String) });
      const receipt = await transport.copy(unit, ids, targetParent);
      const last = log.copies.at(-1)?.destinationId ?? 0;
      if (!Array.isArray(receipt) || receipt.length !== unit.length ||
          receipt.some((id, i) => !forumId(id) || id <= (i ? receipt[i - 1] : last))) {
        return { state: 'mirror_recovery', mirror: { total: log.total, copies: log.copies } };
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
    try {
      const previous = await readJournal();
      const result = status(previous);
      if (operation === 'mirrorstatus' || !['mirror_idle', 'mirror_progress'].includes(result.state)) return result;
      if (operation === 'mirrornext') {
        if (!previous) return result;
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
      if (operation === 'mirrorapprove') {
        return plan.evidence === approval.evidence && approval.expiresAt > now()
          ? await approve(approval, plan) : { state: 'mirror_changed' };
      }
      pending = { approval: randomBytes(32).toString('base64url'), expiresAt: now() + approvalTtl, evidence: plan.evidence };
      return { state: 'mirror_preview', mirror: { approval: pending.approval, expiresAt: pending.expiresAt,
        total: plan.posts.length, source: plan.transport.sourceTitle, destination: plan.transport.destinationTitle,
        posts: plan.posts.map(({ id, contents, message }) => ({ id, kind: contents.kind,
          label: message.entities?.some(entity => entity.className === 'MessageEntitySpoiler') ? '' : contents.filename || contents.text })) } };
    } catch (error) {
      if (!(error instanceof MirrorPreflightError)) throw error;
      return { state: operation === 'mirrorpreview' ? 'mirror_ineligible' : 'mirror_changed', issue: error.issue };
    } finally {
      active = false;
    }
  }

  return { handle, reset() { pending = undefined; } };
}
