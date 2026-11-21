import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createDriveSmokeFile, SMOKE_MARKER } from '../src/rhea/drive-smoke.mjs';

const page = readFileSync(new URL('../src/pages/rhea/[...preview].astro', import.meta.url), 'utf8');
const tools = readFileSync(new URL('../src/rhea/tools.mjs', import.meta.url), 'utf8');

test('synthetic Drive proof is deterministic, small, textual and credential-free', async () => {
  const date = new Date('2026-11-21T03:04:05.000Z');
  const file = createDriveSmokeFile(date);
  assert.equal(file.name, 'rhea-smoke-2026-11-21T03-04-05-000Z.txt');
  assert.equal(file.type, 'text/plain');
  assert.ok(file.size > 50 && file.size < 1024);
  const content = await file.text();
  assert.ok(content.includes(SMOKE_MARKER));
  assert.ok(content.includes('2026-11-21T03:04:05.000Z'));
  assert.equal(content.includes('access_token'), false);
  assert.equal(content.includes('client_secret'), false);
});

test('invalid time is rejected', () => {
  assert.throws(() => createDriveSmokeFile(new Date(Number.NaN)), /valid Date/);
});

test('connection check is explicitly activated from the protected Rhea page', () => {
  assert.match(page, /id="drive-check" type="button" hidden/);
  assert.match(page, /id="drive-check-status" role="status" aria-live="polite"/);
  assert.match(tools, /byId\('drive-check'\)\.addEventListener\('click'/);
  assert.match(tools, /await json\('status'\)/);
  assert.match(tools, /await json\('files'\)/);
});

test('smoke upload occurs only on user click and follows the normal queue', () => {
  assert.match(page, /id="drive-smoke-upload" type="button" hidden/);
  assert.match(tools, /byId\('drive-smoke-upload'\)\.addEventListener\('click'/);
  assert.match(tools, /const data = createDriveSmokeFile\(\)/);
  assert.match(tools, /await enqueueFiles\(\[data\]\)/);
});
