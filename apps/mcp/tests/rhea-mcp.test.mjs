import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));

test('Rhea stdio MCP exposes only explicitly allowlisted read-only tools', async () => {
  const child = spawn(process.execPath, ['apps/mcp/rhea-mcp.mjs'], {
    cwd: root, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = ''; let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'rhea_project_status', arguments: {} } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'rhea_read_document', arguments: { path: 'GEMINI.md' } } },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'rhea_read_document', arguments: { path: '../../.env' } } },
    { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'rhea_delete_drive_file', arguments: { id: 'fake' } } },
    { jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} },
  ];
  child.stdin.end(requests.map(item => JSON.stringify(item)).join('\n') + '\n');
  const [exitCode] = await once(child, 'close');
  assert.equal(exitCode, 0, stderr);
  const answers = stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(answers.length, requests.length - 1, 'Notifications must not have responses');
  const byId = new Map(answers.map(x => [x.id, x]));
  assert.equal(byId.get(1).result.serverInfo.name, 'rhea-readonly');
  assert.equal(byId.get(1).result.serverInfo.title, 'RHEA · Local project context');
  const registered = byId.get(2).result.tools;
  assert.deepEqual(registered.map(x => x.name), ['rhea_project_status', 'rhea_read_document']);
  assert.ok(registered.every(x => x.annotations.readOnlyHint && x.annotations.destructiveHint === false));
  assert.match(byId.get(3).result.content[0].text, /no access to user files/i);
  assert.match(byId.get(4).result.content[0].text, /merge automatically/i);
  assert.equal(byId.get(5).result.isError, true);
  assert.equal(byId.get(6).result.isError, true);
  assert.equal(stderr, '', 'No secrets, file content or diagnostics on stderr');
});
