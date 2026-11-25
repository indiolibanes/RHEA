import assert from 'node:assert/strict';
import test from 'node:test';
import { entryLink, parseFolderLink } from '../src/rhea/mega/folder-link.mjs';

const key = 'AAECAwQFBgcICQoLDA0ODw';
const canonical = `https://mega.nz/folder/AAAAAAAA#${key}`;

test('normalizes modern and legacy MEGA folder share links', () => {
  assert.equal(parseFolderLink(` ${canonical} `), canonical);
  assert.equal(parseFolderLink(`https://mega.io/folder/AAAAAAAA#${key}`), canonical);
  assert.equal(parseFolderLink(`https://mega.co.nz/#F!AAAAAAAA!${key}`), canonical);
});

test('rejects incomplete links, links outside MEGA and non-root shares', () => {
  for (const value of [
    '/folder/AAAAAAAA',
    'https://mega.nz/folder/AAAAAAAA',
    canonical.replace(key, 'short'),
    canonical.replace('https:', 'http:'),
    canonical.replace('mega.nz', 'mega.nz.example.test'),
    canonical.replace('mega.nz', 'alice:secret@mega.nz'),
    canonical.replace('mega.nz', 'mega.nz@elsewhere.test'),
    canonical.replace('/folder/', '/file/'),
    canonical.replace('#', '?key=#'),
    canonical + '/folder/BBBBBBBB',
  ]) {
    assert.equal(parseFolderLink(value), null, value);
  }
});

test('links to official MEGA entries using the root key and a validated node handle', () => {
  assert.equal(entryLink(canonical, { directory: true, downloadId: 'AAAAAAAA' }), canonical);
  assert.equal(entryLink(canonical, { directory: true, downloadId: ['AAAAAAAA', 'BBBBBBBB'] }), canonical + '/folder/BBBBBBBB');
  assert.equal(entryLink(canonical, { directory: false, downloadId: ['AAAAAAAA', 'CCCCCCCC'] }), canonical + '/file/CCCCCCCC');
  assert.equal(entryLink(canonical, { downloadId: ['AAAAAAAA', 'evil/file'] }), null);
});
