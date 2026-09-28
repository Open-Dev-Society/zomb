# zomb

A health check for codebases written with AI.

Coding agents keep creating and never delete. After a few months the repo is full of code nothing uses, three libraries doing one job, `LandingV2` next to `Landing`, keys pasted into files, and API routes anyone can call. `zomb` finds all of it in one command.

```bash
npx zomb              # run inside any git repo
npx zomb path/to/repo --out report.html
```

It writes a single HTML report. Your code never leaves your machine.

## What it checks

**Security**
- API keys pasted into code (Stripe, OpenAI, Anthropic, AWS, GitHub, Slack, Google, database URLs with passwords), shown masked so the report never re-leaks them
- Committed `.env` files
- Secret-looking variables shipped to the browser (`NEXT_PUBLIC_OPENAI_API_KEY`, `VITE_…_SECRET`)
- API routes that change data, or touch the database or payments, with no auth, session, API-key or signature check
- SQL and shell commands built from strings, `eval`, raw HTML from variables, TLS checks turned off
- Known-vulnerable production packages (`npm audit`)

**Zombie code:** code that's in the codebase but not in use
- Files nothing imports or names, and files only their own tests keep alive
- Unused npm packages, and exports nothing imports
- Pages and API routes nothing in the repo links to (listed as "maybe", check your analytics)

**Sprawl:** the codebase only grows
- Lines added vs deleted each month
- Libraries doing the same job (three icon sets, two date libraries…)
- Versioned copies (`V2`, `old`, `copy`, `legacy`), copy-pasted blocks, and helpers defined in more than one file

**Architecture**
- Import cycles, files over 500 lines, shared code scattered across `utils/`, `lib/`, `helpers/`…
- Deep `../../../` imports and mixed file-naming styles

## Good to know

- Install dependencies first: Knip needs them to read your config files.
- Files started by path (`action.yml` entry points, `package.json` scripts), files in dot-folders like `.claude/`, and `*.config.*` files always count as in use.
- Webhooks, auth callbacks, crons and SEO routes are never called "maybe zombie"; repos that are only an API skip that check.
- Key-shaped strings in test files are counted, not listed: tests use fakes to check redaction.
- If your `middleware.ts` checks auth, API routes aren't checked one by one.

## Develop

```bash
npm install
npm test
node src/cli.js ../some-repo
```

MIT
