export const MEGA_API_ORIGIN = 'https://g.api.mega.co.nz';

const hosts = new Set(['mega.nz', 'mega.io', 'mega.co.nz']);
const handlePattern = /^[\w-]{8}$/;

export function parseFolderLink(value) {
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !hosts.has(url.hostname) ||
      url.username || url.password || url.port || url.search) return null;

  const share = (url.pathname + url.hash).match(/^\/folder\/([\w-]{8})\/?#([\w-]{22})$/)
    || (url.pathname === '/' && url.hash.match(/^#F!([\w-]{8})!([\w-]{22})$/));
  if (!share) return null;

  const [, handle, key] = share;
  return `https://mega.nz/folder/${handle}#${key}`;
}

export function entryLink(folderLink, entry) {
  if (!Array.isArray(entry.downloadId)) return folderLink;
  const [, handle] = entry.downloadId;
  if (typeof handle !== 'string' || !handlePattern.test(handle)) return null;
  return `${folderLink}/${entry.directory ? 'folder' : 'file'}/${handle}`;
}
