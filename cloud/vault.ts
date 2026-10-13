// Secrets at rest: drain tokens and the GitHub tokens people hand zomb for automatic Copilot hand-off.
// AES-256-GCM with a key from ZOMB_SECRET_KEY, or one generated into DATA_DIR/secret.key on first start.
// The key file sits next to the database, so this guards copies of the database (backups, dumps), not the disk.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type Vault = { seal: (text: string) => string; open: (sealed: string) => string };

function key(data: string, env: Record<string, string | undefined>): Buffer {
  if (env.ZOMB_SECRET_KEY) {
    const k = /^[0-9a-f]{64}$/i.test(env.ZOMB_SECRET_KEY) ? Buffer.from(env.ZOMB_SECRET_KEY, 'hex') : Buffer.from(env.ZOMB_SECRET_KEY, 'base64');
    if (k.length !== 32) throw new Error('ZOMB_SECRET_KEY must be 32 bytes, as 64 hex characters or base64');
    return k;
  }
  const file = path.join(data, 'secret.key');
  if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString('base64'), { mode: 0o600, flag: 'wx' });
  return Buffer.from(readFileSync(file, 'utf8').trim(), 'base64');
}

export function vault(data: string, env: Record<string, string | undefined> = process.env): Vault {
  const k = key(data, env);
  return {
    seal(text) {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', k, iv);
      const body = Buffer.concat([c.update(text, 'utf8'), c.final()]);
      return ['v1', iv, c.getAuthTag(), body].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join(':');
    },
    open(sealed) {
      const [v, iv, tag, body] = sealed.split(':');
      if (v !== 'v1') throw new Error('unknown secret format');
      const d = createDecipheriv('aes-256-gcm', k, Buffer.from(iv, 'base64url'));
      d.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([d.update(Buffer.from(body, 'base64url')), d.final()]).toString('utf8');
    },
  };
}
