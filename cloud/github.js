// GitHub App plumbing on the standard library: the app's JWT, installation tokens, the REST API, and user sign-in.
import { createHmac, createSign, timingSafeEqual } from 'node:crypto';

export function github({ appId, privateKey, clientId, clientSecret, api = 'https://api.github.com', web = 'https://github.com' }) {
  const b64 = (x) => Buffer.from(JSON.stringify(x)).toString('base64url');
  // the app proves who it is with a JWT signed by its private key, valid for 10 minutes
  const jwt = () => {
    const now = Math.floor(Date.now() / 1000);
    const body = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iat: now - 60, exp: now + 540, iss: String(appId) })}`;
    return `${body}.${createSign('RSA-SHA256').update(body).sign(privateKey, 'base64url')}`;
  };
  const request = async (token, method, url, body) => {
    const res = await fetch(url.startsWith('http') ? url : `${api}${url}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'zomb-cloud', ...(body && { 'content-type': 'application/json' }) },
      body: body && JSON.stringify(body),
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) throw Object.assign(new Error(`${method} ${url}: ${res.status} ${data?.message || text}`), { status: res.status });
    return data;
  };
  // an installation token acts on one customer's repos for an hour; reuse it until 5 minutes before it expires
  const tokens = new Map();
  const installationToken = async (id) => {
    const hit = tokens.get(id);
    if (hit && hit.expires - Date.now() > 5 * 60_000) return hit.token;
    const t = await request(jwt(), 'POST', `/app/installations/${id}/access_tokens`);
    tokens.set(id, { token: t.token, expires: Date.parse(t.expires_at) });
    return t.token;
  };
  return {
    installationToken,
    as: (installation) => async (method, url, body) => request(await installationToken(installation), method, url, body),
    user: (token) => (method, url, body) => request(token, method, url, body),
    loginUrl: (state, redirect) => `${web}/login/oauth/authorize?client_id=${encodeURIComponent(clientId)}&state=${state}&redirect_uri=${encodeURIComponent(redirect)}`,
    async signIn(code) {
      const res = await fetch(`${web}/login/oauth/access_token`, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }) });
      const data = await res.json();
      if (!data.access_token) throw new Error(data.error_description || 'GitHub sign-in failed');
      return data.access_token;
    },
  };
}

// Webhooks are signed with the app's secret: anything else is someone pretending to be GitHub.
export function verify(secret, body, signature = '') {
  const want = Buffer.from(`sha256=${createHmac('sha256', secret).update(body).digest('hex')}`);
  const got = Buffer.from(signature);
  return want.length === got.length && timingSafeEqual(want, got);
}
