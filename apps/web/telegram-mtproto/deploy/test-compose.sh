#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")"

test ! -e secrets
project="rhea-telegram-ci-$(id -u)-$$"
clean() {
  docker compose --project-name "$project" down --volumes
  sudo rm -f secrets/reader.env secrets/tunnel-token
  rmdir secrets
}
mkdir -m 0700 secrets
trap clean EXIT
cat > secrets/reader.env <<'VARS'
RHEA_TELEGRAM_API_ID=12345
RHEA_TELEGRAM_API_HASH=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
RHEA_TELEGRAM_ACCESS_SUB=fixture-owner
RHEA_TELEGRAM_OWNER_ID=1234567
RHEA_TELEGRAM_PHONE=+12345678901
RHEA_TELEGRAM_CHANNEL_ID=9876543210
RHEA_TELEGRAM_CHANNEL_INVITE=https://t.me/+abcdefghijklmnop1234
RHEA_TELEGRAM_MTPROTO_KEY=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
RHEA_TELEGRAM_SESSION_KEY=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
VARS
printf '%s\n' 'synthetic-unused-token' > secrets/tunnel-token
chmod 0400 secrets/reader.env secrets/tunnel-token
sudo chown 1000:1000 secrets/reader.env
docker compose --project-name "$project" --profile tunnel config --quiet
docker compose --project-name "$project" up -d --build --wait --wait-timeout 60 reader
docker compose --project-name "$project" exec -T reader node --env-file=/run/secrets/reader.env --input-type=module - <<'JS'
import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
const uri = 'http://127.0.0.1:8789/v1/status';
const unauthorized = await fetch(uri);
assert.equal(unauthorized.status, 403);
const authorized = await fetch(uri, { headers: {
  Authorization: 'Bearer ' + process.env.RHEA_TELEGRAM_MTPROTO_KEY,
  'X-Rhea-Access-Subject': process.env.RHEA_TELEGRAM_ACCESS_SUB,
} });
assert.equal(authorized.status, 200);
assert.deepEqual(await authorized.json(), { state: 'disconnected' });
const directory = await stat('/var/lib/rhea');
assert.equal(directory.uid, process.getuid());
assert.equal(directory.mode & 0o777, 0o700);
JS
