import { createServer } from 'node:http';
import { isAbsolute } from 'node:path';
import { Readable } from 'node:stream';
import { mtprotoControl } from './control.mjs';
import { sessionStore } from './session-store.mjs';
import { telegramClient } from './telegram.mjs';

export function configuration(env) {
  const id = value => /^[1-9][0-9]{1,18}$/.test(value ?? '');
  const key = value => /^[A-Za-z0-9_-]{43}$/.test(value ?? '');
  const apiId = Number(env.RHEA_TELEGRAM_API_ID);
  const port = Number(env.PORT ?? 8789);
  const bindHost = env.RHEA_TELEGRAM_BIND_HOST ?? '127.0.0.1';
  const invite = value => /^https:\/\/t\.me\/\+([A-Za-z0-9_-]{12,128})$/.exec(value ?? '')?.[1];
  const inviteHash = invite(env.RHEA_TELEGRAM_CHANNEL_INVITE);
  const stagingId = env.RHEA_TELEGRAM_STAGING_CHANNEL_ID;
  const stagingInvite = env.RHEA_TELEGRAM_STAGING_CHANNEL_INVITE;
  const forumId = env.RHEA_TELEGRAM_FORUM_ID;
  const forumInvite = env.RHEA_TELEGRAM_FORUM_INVITE;
  if (env.RHEA_TELEGRAM_MTPROTO_MODE !== 'sandbox' ||
    !/^[1-9][0-9]{0,9}$/.test(env.RHEA_TELEGRAM_API_ID ?? '') || apiId > 0x7fffffff ||
    !/^[a-fA-F0-9]{32}$/.test(env.RHEA_TELEGRAM_API_HASH ?? '') || !id(env.RHEA_TELEGRAM_CHANNEL_ID) ||
    !id(env.RHEA_TELEGRAM_OWNER_ID) || !inviteHash || !/^\+[1-9][0-9]{7,14}$/.test(env.RHEA_TELEGRAM_PHONE ?? '') ||
    !/^[A-Za-z0-9_-]{8,160}$/.test(env.RHEA_TELEGRAM_ACCESS_SUB ?? '') || !key(env.RHEA_TELEGRAM_MTPROTO_KEY) ||
    !key(env.RHEA_TELEGRAM_SESSION_KEY) || env.RHEA_TELEGRAM_SESSION_KEY === env.RHEA_TELEGRAM_MTPROTO_KEY ||
    !isAbsolute(env.RHEA_TELEGRAM_SESSION_FILE ?? '') || !Number.isInteger(port) || port < 1 || port > 65535 ||
    !['127.0.0.1', '0.0.0.0'].includes(bindHost)) {
    throw new Error('Invalid MTProto sandbox configuration.');
  }
  if ((stagingId || stagingInvite) && (!id(stagingId) || !invite(stagingInvite) ||
      stagingId === env.RHEA_TELEGRAM_CHANNEL_ID || invite(stagingInvite) === inviteHash)) {
    throw new Error('Invalid MTProto staging configuration.');
  }
  if ((forumId || forumInvite) && (!id(forumId) || !invite(forumInvite) ||
      [env.RHEA_TELEGRAM_CHANNEL_ID, stagingId].includes(forumId))) {
    throw new Error('Invalid MTProto forum configuration.');
  }
  return {
    apiId, apiHash: env.RHEA_TELEGRAM_API_HASH, channelId: env.RHEA_TELEGRAM_CHANNEL_ID,
    ownerId: env.RHEA_TELEGRAM_OWNER_ID, phone: env.RHEA_TELEGRAM_PHONE, inviteHash, actor: env.RHEA_TELEGRAM_ACCESS_SUB,
    key: env.RHEA_TELEGRAM_MTPROTO_KEY, encryptionKey: Buffer.from(env.RHEA_TELEGRAM_SESSION_KEY, 'base64url'),
    file: env.RHEA_TELEGRAM_SESSION_FILE, port, bindHost,
    staging: stagingId ? { channelId: stagingId, inviteHash: invite(stagingInvite) } : undefined,
    forum: forumId ? { channelId: forumId, inviteHash: invite(forumInvite) } : undefined,
  };
}

function start() {
  const config = configuration(process.env);
  const store = sessionStore(config.file, config.encryptionKey, [config.actor, config.ownerId, config.channelId, config.apiId]);
  const handle = mtprotoControl(config, store, telegramClient(config));
  createServer({ requestTimeout: 12_000, headersTimeout: 8000, maxHeaderSize: 8192 }, async (incoming, outgoing) => {
    try {
      if (!incoming.url?.startsWith('/') || incoming.url.startsWith('//')) throw new Error('Invalid request target.');
      const hasBody = incoming.headers['transfer-encoding'] || Number(incoming.headers['content-length']) > 0;
      const request = new Request('http://127.0.0.1' + incoming.url, {
        method: incoming.method, headers: incoming.headers,
        ...(hasBody ? { body: Readable.toWeb(incoming), duplex: 'half' } : {}),
      });
      const reply = await handle(request);
      outgoing.writeHead(reply.status, Object.fromEntries(reply.headers));
      outgoing.end(Buffer.from(await reply.arrayBuffer()));
    } catch {
      outgoing.writeHead(400, { 'Cache-Control': 'no-store' });
      outgoing.end();
    }
  }).listen(config.port, config.bindHost);
}

if (import.meta.main) start();
