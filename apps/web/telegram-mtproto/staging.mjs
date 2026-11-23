import { createHash, randomBytes } from 'node:crypto';
import { open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { catalogSnapshot } from '../src/rhea/library/live-catalog.mjs';
import { planReflow } from '../src/rhea/library/planner.mjs';

const approvalTtl = 5 * 60_000;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function stagingControl(config, now = Date.now) {
  if (!config.staging) return { handle: async () => ({ state: 'stage_disabled' }), reset() {} };
  const scope = digest([config.actor, config.ownerId, config.channelId, config.staging.channelId]);
  const journal = join(dirname(config.file), 'staging-' + digest(config.staging.channelId) + '.jsonl');
  let pending;

  async function priorRun() {
    let handle;
    try {
      handle = await open(journal, 'r');
      if ((await handle.stat()).size > 8192) return { state: 'stage_recovery' };
      const records = (await handle.readFile('utf8')).trim().split('\n').map(line => JSON.parse(line));
      const last = records.at(-1);
      return records[0]?.scope === scope && last?.type === 'verified'
        ? { state: 'stage_done', copies: last.copies }
        : { state: 'stage_recovery' };
    } catch (error) {
      return error.code === 'ENOENT' ? null : { state: 'stage_recovery' };
    } finally {
      await handle?.close();
    }
  }

  async function inspect(transport) {
    const source = await transport.readSource();
    const destination = await transport.readDestination();
    if (!source || !destination || source.posts.length !== 3 || destination.posts.length) return null;
    const sourceRevision = digest(source);
    const snapshot = catalogSnapshot({
      channelId: config.channelId, revision: sourceRevision, complete: true,
      messages: source.posts.map(({ id, caption, filename }) => ({ id, caption, filename, copyPolicy: 'allowed' })),
    });
    if (snapshot.messages.some(post => !post.seriesId || !Number.isInteger(post.season) ||
      !Number.isInteger(post.episode) || post.part != null)) return null;
    const slots = snapshot.messages.map(post => JSON.stringify([post.seriesId, post.season, post.episode]));
    if (new Set(slots).size !== 3 || new Set(source.posts.map(post => post.mediaId)).size !== 3) return null;
    const plan = await planReflow(snapshot, { strategy: 'staging', batchSize: 1 });
    if (plan.blockers.length) return null;
    const posts = plan.targetIds.map(id => source.posts.find(post => post.id === id));
    return { sourceRevision, evidence: digest([scope, sourceRevision, destination, plan.planHash, transport.sourceTitle, transport.destinationTitle]),
      posts, source: transport.sourceTitle, destination: transport.destinationTitle, baseline: destination };
  }

  async function execute(transport, plan) {
    let handle;
    try {
      handle = await open(journal, 'wx', 0o600);
    } catch (error) {
      if (error.code === 'EEXIST') return { state: 'stage_recovery' };
      throw error;
    }
    const record = async event => {
      await handle.writeFile(JSON.stringify(event) + '\n');
      await handle.sync();
    };
    const copies = [];
    let destination = plan.baseline;
    try {
      await record({ type: 'approved', scope, evidence: plan.evidence, at: now(), sourceIds: plan.posts.map(post => post.id) });
      const directory = await open(dirname(journal), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
      const verifiedPosts = [];
      for (const post of plan.posts) {
        if (digest(await transport.readSource()) !== plan.sourceRevision ||
            digest(await transport.readDestination()) !== digest(destination)) throw new Error('Channel changed.');
        const randomId = (randomBytes(8).readBigUInt64BE() >> 1n) || 1n;
        await record({ type: 'intent', sourceId: post.id, randomId: randomId.toString() });
        const destinationId = await transport.copy(post.id, randomId);
        if (!Number.isInteger(destinationId) || destinationId <= destination.head) throw new Error('Invalid receipt.');
        await record({ type: 'receipt', sourceId: post.id, destinationId });
        copies.push({ sourceId: post.id, destinationId });
        verifiedPosts.push({ ...post, id: destinationId });
        destination = await transport.readDestination();
        if (destination?.head !== destinationId ||
            digest(destination.posts) !== digest(verifiedPosts)) throw new Error('Readback mismatch.');
      }
      for (const { destinationId } of copies) {
        if (!await transport.verifyMedia(destinationId)) throw new Error('Media readback failed.');
      }
      if (digest(await transport.readSource()) !== plan.sourceRevision ||
          digest(await transport.readDestination()) !== digest(destination)) throw new Error('Channel changed.');
      await record({ type: 'verified', copies });
      return { state: 'stage_done', copies };
    } catch {
      return { state: 'stage_recovery' };
    } finally {
      await handle.close();
    }
  }

  async function handle(operation, input, client) {
    const previous = await priorRun();
    if (previous) return previous;
    if (operation === 'stagepreview') {
      pending = undefined;
      const transport = await client.staging();
      const plan = transport && await inspect(transport);
      if (!plan) return { state: 'stage_ineligible' };
      pending = { approval: randomBytes(32).toString('base64url'), expiresAt: now() + approvalTtl, evidence: plan.evidence };
      return { state: 'stage_preview', stage: { approval: pending.approval, expiresAt: pending.expiresAt,
        source: plan.source, destination: plan.destination, posts: plan.posts.map(({ id, caption }) => ({ id, caption })) } };
    }

    const approval = pending;
    if (!approval || input.confirm !== true || approval.approval !== input.approval || approval.expiresAt <= now()) {
      return { state: 'stage_changed' };
    }
    pending = undefined;
    const transport = await client.staging();
    const plan = transport && await inspect(transport);
    if (!plan || plan.evidence !== approval.evidence || approval.expiresAt <= now()) return { state: 'stage_changed' };
    return execute(transport, plan);
  }

  return { handle, reset() { pending = undefined; } };
}
