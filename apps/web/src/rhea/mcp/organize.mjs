import { DriveError, driveFiles, folderType, publicFile, requireName } from '../drive-files.mjs';

const id = { type: 'string', pattern: '^[A-Za-z0-9_-]{5,200}$' };
const name = { type: 'string', minLength: 1, maxLength: 200 };
const list = (items, maxItems) => ({ type: 'array', items, minItems: 1, maxItems, uniqueItems: items === id });
const tool = (name, description, properties, required) => ({
  name: 'rhea_' + name, description,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: { type: 'object', properties, required, additionalProperties: false },
  outputSchema: { type: 'object' },
});

export const organizationTools = [
  tool('create_folder', 'Create or locate a unique folder within the authorized Drive tree.', { parent_id: id, name }, ['name']),
  tool('move_file', 'Move one file to an existing folder within the authorized Drive tree.', { file_id: id, parent_id: id }, ['file_id', 'parent_id']),
  tool('organize_files', 'Create the folder path under the authorized Drive root and move the listed files in one operation. Retry the same arguments after partial completion.',
    { folder_path: list(name, 6), file_ids: list(id, 24) }, ['folder_path', 'file_ids']),
];

async function ensureFolder(service, parent, name, permit) {
  requireName(name);
  const existing = await service.matches(parent, name);
  if (existing.length === 1 && existing[0].mimeType === folderType) {
    return publicFile((await service.authorize(existing[0].id, true)).file);
  }
  if (existing.length) throw new DriveError(409, 'An existing item prevents using this folder name.');
  await permit();
  try { return await service.createFolder(parent, name); }
  catch (error) {
    if (error.code !== 'name_conflict') throw error;
    const current = await service.matches(parent, name);
    if (current.length !== 1 || current[0].mimeType !== folderType) throw error;
    return publicFile((await service.authorize(current[0].id, true)).file);
  }
}

async function validateFile(service, id) {
  const { file } = await service.authorize(id);
  if (file.mimeType === folderType) throw new DriveError(400, 'This operation moves files. Choose a file instead of a folder.');
  return file;
}

export async function organizeTool(action, args, token, fetcher, permit) {
  const service = driveFiles(token, fetcher);
  if (action === 'rhea_create_folder') {
    const { file } = await service.authorize(args.parent_id ?? null, true);
    return { file: await ensureFolder(service, file.id, args.name, permit) };
  }
  if (action === 'rhea_move_file') {
    await validateFile(service, args.file_id);
    await permit();
    return { file: await service.change('move', args.file_id, { parent: args.parent_id }) };
  }

  const source = [];
  const names = new Set();
  for (const id of args.file_ids) {
    const file = await validateFile(service, id);
    if (names.has(file.name)) throw new DriveError(409, 'Two selected files have the same name.');
    names.add(file.name);
    source.push(file);
  }
  args.folder_path.forEach(requireName);
  let { file: destination } = await service.authorize(null, true);
  for (const label of args.folder_path) destination = await ensureFolder(service, destination.id, label, permit);

  for (const file of source) {
    const conflicts = await service.matches(destination.id, file.name);
    if (conflicts.some(other => other.id !== file.id)) throw new DriveError(409, 'A selected name already exists in the destination.');
  }
  const completed = [];
  for (let index = 0; index < source.length; index++) {
    const file = source[index];
    try {
      await permit();
      completed.push(await service.change('move', file.id, { parent: destination.id }));
    } catch {
      return { state: 'PARTIAL', destination: publicFile(destination), completed,
        remaining: source.slice(index).map(item => item.id), retryable: true };
    }
  }
  return { state: 'VERIFIED', destination: publicFile(destination), completed };
}
