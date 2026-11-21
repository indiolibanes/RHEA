import { DriveError, driveFiles, requireName, uploadMetadata } from '../drive-files.mjs';
import { proofDigest, random, secretValue, timestamp } from './security.mjs';

const id = { type: 'string', pattern: '^[A-Za-z0-9_-]{5,200}$' };
const name = { type: 'string', minLength: 1, maxLength: 200 };
const makeTool = (action, description, properties, required) => ({
  name: 'rhea_' + action,
  description: description + ' The user must review and approve this proposal in the RHEA workspace.',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  inputSchema: { type: 'object', properties, required, additionalProperties: false },
  outputSchema: { type: 'object', required: ['proposalId', 'state'],
    properties: { proposalId: { type: 'string' }, state: { type: 'string', const: 'PROPOSED' } } },
});
export const writeTools = [
  makeTool('create_folder', 'Propose creating a folder.', { parent_id: id, name }, ['name']),
  makeTool('rename_file', 'Propose changing a file or folder name.', { file_id: id, name }, ['file_id', 'name']),
  makeTool('move_file', 'Propose moving a file or folder inside the authorized Drive tree.', { file_id: id, parent_id: id }, ['file_id', 'parent_id']),
  makeTool('trash_file', 'Propose reversible trash.', { file_id: id }, ['file_id']),
  makeTool('prepare_upload', 'Propose an upload destination. The user supplies the actual file in the RHEA workspace.', {
    parent_id: id, name, size: { type: 'integer', minimum: 1, maximum: 512 * 1024 ** 2 },
  }, ['name', 'size']),
];

const sourceState = file => ({ id: file.id, name: String(file.name).slice(0, 512), parent: file.parents?.[0] ?? null,
  modified: file.modifiedTime ?? null, size: file.size ?? null });
const destinationState = ({ file, chain }) => ({ id: file.id,
  path: chain.map(node => String(node.name).slice(0, 160)).join(' / ') });
const stateEvent = 'INSERT INTO rhea_proposal_events(proposal_id,state,actor_hash,client,action,created) VALUES(?,?,?,?,?,?)';

export function proposals(cfg) {
  const stmt = (sql, ...args) => cfg.db.prepare(sql).bind(...args);
  const event = async (id, state, actor, client, action) => stmt(stateEvent, id, state,
    await proofDigest(cfg.secret, 'rhea-proposal-audit:' + actor), client, action, timestamp());
  const activeGrant = 'EXISTS(SELECT 1 FROM oauth_grants g WHERE g.id=p.grant_id AND g.revoked IS NULL AND g.expires>?)';

  async function create(grant, action, args, token, fetcher) {
    const service = driveFiles(token, fetcher);
    const data = {};
    if (args.file_id) {
      const { file, root } = await service.authorize(args.file_id);
      if (file.id === root.id) throw new DriveError(403, 'The Drive root is protected.');
      data.source = sourceState(file);
    }
    if (['rhea_create_folder', 'rhea_move_file', 'rhea_prepare_upload'].includes(action)) {
      const location = await service.authorize(args.parent_id ?? null, true);
      if (action === 'rhea_move_file' && location.chain.some(item => item.id === data.source.id)) {
        throw new DriveError(409, 'This move would create a folder cycle.');
      }
      data.destination = destinationState(location);
    }
    if (args.name !== undefined) data.name = requireName(args.name);
    if (action === 'rhea_prepare_upload') data.size = uploadMetadata(args).size;
    const proposalId = random();
    const now = timestamp();
    await cfg.db.batch([
      stmt(`INSERT INTO rhea_proposals(id,grant_id,actor,account,client,action,payload,state,created,expires)
        VALUES(?,?,?,?,?,?,?,'PROPOSED',?,?)`, proposalId, grant.id, grant.actor, grant.account, grant.client, action,
      JSON.stringify(data), now, Math.min(grant.expires, now + 900)),
      await event(proposalId, 'PROPOSED', grant.actor, grant.client, action),
    ]);
    return { proposalId, state: 'PROPOSED' };
  }

  async function list(actor, account) {
    const results = await stmt(`SELECT id,client,action,payload,state FROM rhea_proposals AS p WHERE actor=? AND account=?
      AND expires>? AND ${activeGrant} ORDER BY created DESC LIMIT 20`, actor, account, timestamp(), timestamp()).all();
    return results.results.map(row => ({ ...row, client: cfg.clients.get(row.client)?.label ?? 'RHEA', payload: JSON.parse(row.payload) }));
  }

  async function transition(id, actor, account, from, to) {
    if (!secretValue(id)) return null;
    const now = timestamp();
    const state = await stmt(`UPDATE rhea_proposals AS p SET state=? WHERE id=? AND actor=? AND account=? AND state=?
      AND expires>? AND ${activeGrant} RETURNING id, action, payload, client`, to, id, actor, account, from, now, now).first();
    if (state) await (await event(id, to, actor, state.client, state.action)).run();
    return state;
  }

  async function review(id, actor, account) {
    return Boolean(await transition(id, actor, account, 'PROPOSED', 'USER_REVIEW'));
  }

  async function execute(input, actor, session, fetcher) {
    const { id, confirmed } = input ?? {};
    if (confirmed !== true || !secretValue(id)) throw new DriveError(400, 'A confirmação explícita é obrigatória.');
    const approved = await transition(id, actor, session.account, 'USER_REVIEW', 'AUTHORIZED');
    if (!approved) throw new DriveError(409, 'A proposta expirou ou precisa ser revisada.');
    const executing = await transition(id, actor, session.account, 'AUTHORIZED', 'EXECUTING');
    if (!executing) throw new DriveError(409, 'A autorização já mudou ou expirou.');
    const finish = async state => {
      await stmt("UPDATE rhea_proposals SET state=? WHERE id=? AND state='EXECUTING'", state, id).run();
      await (await event(id, state, actor, executing.client, executing.action)).run();
    };
    try {
      const p = JSON.parse(executing.payload);
      const service = driveFiles(session.token, fetcher);
      if (p.source) {
        const current = (await service.authorize(p.source.id)).file;
        if (JSON.stringify(sourceState(current)) !== JSON.stringify(p.source)) {
          throw new DriveError(409, 'O arquivo mudou desde a proposta. Solicite uma nova proposta.');
        }
      }
      if (p.destination) {
        const current = await service.authorize(p.destination.id, true);
        if (JSON.stringify(destinationState(current)) !== JSON.stringify(p.destination)) {
          throw new DriveError(409, 'O destino mudou desde a proposta. Solicite uma nova proposta.');
        }
      }
      let result;
      switch (executing.action) {
        case 'rhea_create_folder': result = await service.createFolder(p.destination.id, p.name); break;
        case 'rhea_rename_file': result = await service.change('rename', p.source.id, { name: p.name }); break;
        case 'rhea_move_file': result = await service.change('move', p.source.id, { parent: p.destination.id }); break;
        case 'rhea_trash_file': result = await service.change('trash', p.source.id, { confirmed: true }); break;
        case 'rhea_prepare_upload': result = { preparationOnly: true, folderId: p.destination.id, name: p.name, size: p.size }; break;
        default: throw new DriveError(400, 'Ação desconhecida.');
      }
      await finish('VERIFIED');
      return { state: 'VERIFIED', result };
    } catch (error) {
      await finish('FAILED');
      throw error;
    }
  }

  async function cleanup() {
    const now = timestamp();
    await cfg.db.batch([
      stmt('DELETE FROM rhea_proposals WHERE expires < ?', now),
      stmt('DELETE FROM rhea_proposal_events WHERE created < ?', now - 30 * 86_400),
    ]);
  }
  return { create, list, review, execute, cleanup };
}
