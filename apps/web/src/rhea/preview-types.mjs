export const textLimit = 64 * 1024;
export const mediaLimit = 12 * 1024 ** 2;
const textTypes = new Set(['text/plain', 'text/markdown', 'text/csv', 'application/json', 'application/yaml']);
const mediaTypes = new Map([
  ['image/png', 'image'], ['image/jpeg', 'image'], ['image/webp', 'image'], ['image/gif', 'image'],
  ['video/mp4', 'video'], ['video/webm', 'video'],
]);
const byExtension = new Map([
  ['txt', 'text/plain'], ['md', 'text/markdown'], ['csv', 'text/csv'], ['json', 'application/json'],
  ['yaml', 'application/yaml'], ['yml', 'application/yaml'], ['png', 'image/png'],
  ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'], ['webp', 'image/webp'], ['gif', 'image/gif'],
  ['mp4', 'video/mp4'], ['webm', 'video/webm'],
]);

export function previewType({ name, mimeType, size }) {
  const extension = name.split('.').at(-1).toLowerCase();
  const type = mimeType && mimeType !== 'application/octet-stream' ? mimeType.split(';')[0] : byExtension.get(extension);
  if (textTypes.has(type)) return { kind: 'text', type: 'text/plain; charset=utf-8', max: textLimit };
  if (mediaTypes.has(type) && size <= mediaLimit) return { kind: mediaTypes.get(type), type, max: mediaLimit };
  return null;
}
