# zomb Cloud

A GitHub App around the zomb CLI. Install it and you're done: no workflow file.

- **Every pull request** gets a `zomb` check and one comment, updated on each push. The check fails on new findings at or above `fail-on`.
- **Every push to the default branch** is scanned, and the dashboard shows each repo's trend: high security issues, zombie lines, unused packages, architecture and blueprint breaks.
- **Once a week** each repo gets one clean-up issue with zomb's verified task list, kept up to date and closed when the list is empty. It goes to the agent the team already pays for: `@claude` is mentioned in it, or one click in the dashboard assigns it to Copilot (Copilot only takes assignments from a person's token, not an app's). zomb never runs your builds: the agent does the work in your own CI.

## Run it

```bash
ZOMB_URL=https://zomb.example.com node cloud/server.js
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
handoff: claude    # claude (mention @claude), copilot (a button in the dashboard) or none
```

`.zomb/blueprint.yml` and `.zomb/baseline.json` work as they do in the CLI.

## Before you host it for other people

Scanning installs a repo's dependencies (with `--ignore-scripts`) and Knip loads its config files, so a scan runs some of that repo's code. Jobs get a clean environment with no server secrets, and the GitHub token never touches the checkout, but they still run as the server's user. That's fine for your own repos. Before scanning code you don't trust, run each job in its own container. The place to do that is `checkout()` in `cloud/jobs.js`.

Not here yet: dead routes from production traffic, billing, and fully automatic Copilot hand-off (it needs a stored user token).
