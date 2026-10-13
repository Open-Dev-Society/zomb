# zomb Cloud

A GitHub App around the zomb CLI. Install it and you're done: no workflow file.

- **Every pull request** gets a `zomb` check and one comment, updated on each push. The check fails on new findings at or above `fail-on`.
- **Every push to the default branch** is scanned, and the dashboard shows each repo's trend: high security issues, zombie lines, unused packages, architecture and blueprint breaks.
- **Once a week** each repo gets one clean-up issue with zomb's verified task list, kept up to date and closed when the list is empty. It goes to the agent the team already pays for: `@claude` is mentioned in it, or it is assigned to Copilot, with one click in the dashboard or automatically every week. zomb never runs your builds: the agent does the work in your own CI.
- **Production traffic**, if you send it, tells each scan which pages and API routes nobody requests any more.

## Run it

```bash
ZOMB_URL=https://zomb.example.com node cloud/server.ts
```

or with Docker:

```bash
docker build -f cloud/Dockerfile -t zomb-cloud .
docker run -p 3000:3000 -v zomb:/data -e ZOMB_URL=https://zomb.example.com zomb-cloud
```

Then open `ZOMB_URL/setup` and click **Create the app on GitHub**. GitHub creates the app from its manifest (permissions: contents read, pull requests, issues and checks write) and sends its keys back, saved in `DATA_DIR/app.json`. Restart, install the app on your repos, and sign in at `ZOMB_URL`.

GitHub must be able to reach `ZOMB_URL/webhook`. On your laptop, a tunnel works: `cloudflared tunnel --url http://localhost:3000`.

Instead of `/setup`, you can pass an existing app's credentials: `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_PRIVATE_KEY` (PEM or base64), `GITHUB_WEBHOOK_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`.

## Per repo settings

`.zomb/config.yml`, all optional:

```yaml
fail-on: high      # the PR check fails on new findings at this level (high, medium, low)
weekly: true       # the weekly clean-up issue
handoff: claude    # claude (mention @claude), copilot (a dashboard button, or automatic) or none
```

`.zomb/blueprint.yml` and `.zomb/baseline.json` work as they do in the CLI.

## Traffic: routes nobody visits

Each repo's settings page (the **settings** link under its name on the dashboard) has a drain endpoint, `ZOMB_URL/drain/<repo id>`, and a token.

- **Vercel:** add a Drain for logs with JSON delivery to the endpoint, and use the token as its signature secret. zomb checks the `x-vercel-signature` header.
- **Anything else:** POST an access log, JSON lines or a JSON array with `Authorization: Bearer <token>`, gzipped (`Content-Encoding: gzip`) or not, up to 5 MB at a time.

zomb keeps only each path and a daily count, for 90 days. Static files are skipped, and a repo keeps at most 10,000 distinct paths a day. Once a repo has 14 days of traffic, push and weekly scans pass the last 30 days to `zomb --traffic`. The weekly issue then lists the routes no request reached. A route that is linked but never visited is asked about, and one with no links and no traffic is marked for deletion. **Make a new token** on the settings page turns the old one off.

## Copilot, automatically

Copilot only takes an assignment from a person, never from an app. On a repo's settings page, **Hand issues to Copilot every week** signs you in once more and keeps that GitHub token, so the weekly job can assign the issue as you. It does that only while the repo's `.zomb/config.yml` says `handoff: copilot`, and skips issues Copilot already has.

The token is encrypted at rest with AES-256-GCM. The key comes from `ZOMB_SECRET_KEY` (32 bytes, as hex or base64), or from a key generated into `DATA_DIR/secret.key`. The generated key sits next to the database, so it protects copies of the database (backups, dumps), not the disk. Set `ZOMB_SECRET_KEY` to keep the two apart. GitHub user tokens last 8 hours, so zomb refreshes them with the refresh token, which GitHub replaces on every use. If GitHub refuses the token, or you revoke zomb in your GitHub settings, zomb deletes it, puts the manual line back on the issue, and the dashboard shows **Copilot stopped** until someone turns it on again. Turning it off on every repo deletes the token.

## Scans in containers

Scanning installs a repo's dependencies (with `--ignore-scripts`) and Knip loads its config files, so a scan runs some of that repo's code. By default that happens as the server's user, in a clean environment with no server secrets. That's fine for your own repos.

Before you scan code you don't trust, set `ZOMB_SANDBOX=docker`. The server still fetches each repo itself, so the GitHub token never enters a container. It streams the checkout into a throwaway container, where the install and the scan run as an unprivileged user with no capabilities and no way to gain privileges, limited to 2 GB of memory, 2 CPUs and 512 processes, for at most 10 minutes. The container is removed when the scan ends.

- `ZOMB_SANDBOX_IMAGE`: the image scans run in, `zomb-cloud` by default. The Dockerfile above builds it, Docker CLI included. The server checks at startup that the image exists.
- `ZOMB_SANDBOX_NETWORK`: the Docker network scan containers join. Installing needs the package registry, so by default they use Docker's bridge network, which reaches whatever the host reaches. Give them a network that only reaches your registry (or a mirror) to keep scans out of your private network. With `none`, installs fail and Knip reads each repo without its dependencies, so some findings get less precise.

To run the server itself in Docker with the sandbox on, give it the host's Docker socket:

```bash
docker run -p 3000:3000 -v zomb:/data -v /var/run/docker.sock:/var/run/docker.sock \
  -e ZOMB_SANDBOX=docker -e ZOMB_URL=https://zomb.example.com zomb-cloud
```

Whoever holds that socket controls the host. Only the server container gets it; scan containers never do. If that trade is wrong for you, run the server straight on a host with Docker, or point it at a rootless Docker daemon (`DOCKER_HOST`).

Not here yet: billing.
