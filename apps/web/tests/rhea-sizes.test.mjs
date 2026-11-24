import assert from 'node:assert/strict';
import test from 'node:test';
import { formatSize } from '../src/rhea/library/sizes.mjs';

test('sizes use one binary unit rule and keep exact bytes on request', () => {
  assert.equal(formatSize(0), '0 bytes');
  assert.equal(formatSize(1023), '1.023 bytes');
  assert.equal(formatSize(1024), '1 KiB');
  assert.equal(formatSize(1_572_864), '1,5 MiB');
  assert.equal(formatSize(4_294_967_396n), '4 GiB');
  assert.equal(formatSize(4_294_967_396n, { exact: true }), '4 GiB (4.294.967.396 bytes)');
  assert.equal(formatSize(512, { exact: true }), '512 bytes');
  assert.equal(formatSize(-1), '');
  assert.equal(formatSize('abc'), '');
  assert.equal(formatSize(1.5), '');
});
