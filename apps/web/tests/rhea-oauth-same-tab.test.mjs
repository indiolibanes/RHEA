import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const page = readFileSync(new URL('../src/pages/rhea/[...preview].astro', import.meta.url), 'utf8');
const tools = readFileSync(new URL('../src/rhea/tools.mjs', import.meta.url), 'utf8');
const preview = readFileSync(new URL('../src/rhea/rhea.mjs', import.meta.url), 'utf8');
const api = readFileSync(new URL('../functions/api/rhea/[action].js', import.meta.url), 'utf8');

test('Google Drive connect keeps OAuth on the same browser tab', () => {
  assert.match(page, /id="drive-connect" href="\/api\/rhea\/connect"/);
  const link = page.match(/<a[^>]*id="drive-connect"[^>]*>/)?.[0];
  assert.ok(link, 'Drive OAuth link must exist');
  assert.doesNotMatch(link, /target=/, 'No target=_blank or new browser context');
  assert.match(page, /id="drive-status"/);
});

test('guard users against loss of non-persistent local selections', () => {
  assert.match(tools, /uploadPanel\.snapshot\(\)\.filter\(item => item\.data && !item\.stored\)/);
  assert.match(tools, /window\.confirm\(/);
  assert.match(tools, /event\.preventDefault\(\)/);
  assert.match(preview, /enqueueFiles\(Array\.from\(files\)\)/);
});

test('callback logs only fixed fields, not token or state values', () => {
  assert.match(api, /\[rhea-oauth\] callback_received/);
  assert.match(api, /oauthProofCookiePresent: Boolean\(readCookie\(request, stateCookie\)\)/);
  assert.match(api, /\[rhea-oauth\] session_cookie_issued/);
  assert.match(api, /oauthStateCookiePresent/);
  assert.doesNotMatch(api, /console\.(info|log|warn)\([^\n]*\b(token|sessionCookie|proof\.state)\b/);
});
