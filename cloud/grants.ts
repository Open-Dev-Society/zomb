// The GitHub tokens people hand zomb so it can assign the weekly issue to Copilot without a click:
// Copilot only takes assignments from a person, never from an app. Sealed at rest, refreshed one at a time.
import type { UserToken } from './github.ts';
import type { Vault } from './vault.ts';

const EARLY = 5 * 60_000;

export function grants({ db, vault, gh }: { db: any; vault: Vault; gh: { refresh: (t: string) => Promise<UserToken> } }) {
  db.exec('CREATE TABLE IF NOT EXISTS grants (login TEXT PRIMARY KEY, token TEXT NOT NULL, expires INTEGER, refresh TEXT, refresh_expires INTEGER)');
  const put = (login: string, t: UserToken) =>
    db
      .prepare('INSERT INTO grants (login, token, expires, refresh, refresh_expires) VALUES (?, ?, ?, ?, ?) ON CONFLICT(login) DO UPDATE SET token = excluded.token, expires = excluded.expires, refresh = excluded.refresh, refresh_expires = excluded.refresh_expires')
      .run(login, vault.seal(t.token), t.expires, t.refresh && vault.seal(t.refresh), t.refreshExpires);
  // a refresh token works once: two jobs refreshing the same grant at the same time would lose it
  const inflight = new Map<string, Promise<string>>();

  async function token(login: string): Promise<string> {
    const g = db.prepare('SELECT * FROM grants WHERE login = ?').get(login) as any;
    if (!g) throw Object.assign(new Error(`no grant for ${login}`), { code: 'no_grant' });
    if (g.expires === null || g.expires - Date.now() > EARLY) return vault.open(g.token);
    if (!g.refresh || (g.refresh_expires && g.refresh_expires < Date.now())) throw Object.assign(new Error(`${login}'s grant expired`), { code: 'bad_refresh_token' });
    const fresh = await gh.refresh(vault.open(g.refresh));
    put(login, fresh);
    return fresh.token;
  }

  return {
    save: put,
    has: (login: string) => Boolean(login && db.prepare('SELECT 1 FROM grants WHERE login = ?').get(login)),
    drop: (login: string) => db.prepare('DELETE FROM grants WHERE login = ?').run(login),
    token(login: string) {
      if (!inflight.has(login)) inflight.set(login, token(login).finally(() => inflight.delete(login)));
      return inflight.get(login)!;
    },
  };
}
export type Grants = ReturnType<typeof grants>;
