// GitHub App plumbing on the standard library: the app's JWT, installation tokens, the REST API, and user sign-in.
import { createHmac, createSign, timingSafeEqual } from 'node:crypto';

export type Api = (method: string, url: string, body?: unknown) => Promise<any>;

export function github({ appId, privateKey, clientId, clientSecret, api = 'https://api.github.com', web = 'https://github.com' }: { appId?: string | number; privateKey: string; clientId?: string; clientSecret?: string; api?: string; web?: string }) {
  const b64 = (x: unknown) => Buffer.from(JSON.stringify(x)).toString('base64url');
  // the app proves who it is with a JWT signed by its private key, valid for 10 minutes
  const jwt = () => {
    const now = Math.floor(Date.now() / 1000);
    const body = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iat: now - 60, exp: now + 540, iss: String(appId) })}`;
    return `${body}.${createSign('RSA-SHA256').update(body).sign(privateKey, 'base64url')}`;
  };
  const request = async (token: string, method: string, url: string, body?: unknown): Promise<any> => {
    const res = await fetch(url.startsWith('http') ? url : `${api}${url}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'zomb-cloud', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) throw Object.assign(new Error(`${method} ${url}: ${res.status} ${(data as { message?: string })?.message || text}`), { status: res.status });
    return data;
  };
  // an installation token acts on one customer's repos for an hour; reuse it until 5 minutes before it expires
  const tokens = new Map<number | string, { token: string; expires: number }>();
  const installationToken = async (id: number | string): Promise<string> => {
    const hit = tokens.get(id);
    if (hit && hit.expires - Date.now() > 5 * 60_000) return hit.token;
    const t = await request(jwt(), 'POST', `/app/installations/${id}/access_tokens`);
    tokens.set(id, { token: t.token, expires: Date.parse(t.expires_at) });
    return t.token;
  };
  return {
    installationToken,
    as: (installation: number | string): Api => async (method, url, body) => request(await installationToken(installation), method, url, body),
    user: (token: string): Api => (method, url, body) => request(token, method, url, body),
    loginUrl: (state: string, redirect: string) => `${web}/login/oauth/authorize?client_id=${encodeURIComponent(clientId || '')}&state=${state}&redirect_uri=${encodeURIComponent(redirect)}`,
    async signIn(code: string) {
      const res = await fetch(`${web}/login/oauth/access_token`, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }) });
      const data = (await res.json()) as { access_token?: string; error_description?: string };
      if (!data.access_token) throw new Error(data.error_description || 'GitHub sign-in failed');
      return data.access_token;
    },
  };
}

// Webhooks are signed with the app's secret: anything else is someone pretending to be GitHub.
export function verify(secret: string, body: Buffer | string, signature: string | string[] | undefined = '') {
  const want = Buffer.from(`sha256=${createHmac('sha256', secret).update(body).digest('hex')}`);
  const got = Buffer.from(String(signature));
  return want.length === got.length && timingSafeEqual(want, got);
}
