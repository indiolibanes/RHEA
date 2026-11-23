import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { open, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export function sessionStore(file, key, binding) {
  const associatedData = Buffer.from(JSON.stringify(['rhea-telegram-session-v1', ...binding]));
  return {
    async read() {
      let sealed;
      try {
        sealed = await readFile(file);
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
      if (sealed.length < 29 || sealed.length > 4096) throw new Error('Invalid session envelope.');
      const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, 12));
      decipher.setAAD(associatedData);
      decipher.setAuthTag(sealed.subarray(12, 28));
      return Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()]).toString('utf8');
    },
    async write(session) {
      if (typeof session !== 'string' || !session.length || Buffer.byteLength(session) > 4000) {
        throw new Error('Invalid session.');
      }
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(associatedData);
      const ciphertext = Buffer.concat([cipher.update(session, 'utf8'), cipher.final()]);
      const temporary = join(dirname(file), '.' + basename(file) + '.' + randomBytes(8).toString('hex'));
      try {
        const handle = await open(temporary, 'wx', 0o600);
        try {
          await handle.writeFile(Buffer.concat([iv, cipher.getAuthTag(), ciphertext]));
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temporary, file);
      } finally {
        await rm(temporary, { force: true });
      }
    },
    async clear() {
      await rm(file, { force: true });
    },
  };
}
