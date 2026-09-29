# zomb

A health check for codebases written with AI.

Coding agents keep creating and never delete. After a few months the repo is full of code nothing uses, three libraries doing one job, `LandingV2` next to `Landing`, keys pasted into files, and API routes anyone can call. `zomb` finds all of it in one command.

```bash
npx zomb              # run inside any git repo
npx zomb path/to/repo --out report.html
```

It prints a summary and writes a single HTML report to `.zomb/report.html` (git-ignored). Your code never leaves your machine.

```bash
zomb --all                # every finding in the terminal, not just the top 5
zomb --json               # an ordered to-do list for an AI agent or CI
zomb --since main         # only what your branch changed, plus the shortcuts it took
zomb --since HEAD         # only your uncommitted work
```

## Clean up automatically

```bash
zomb fix --dry-run     # show what it would remove
zomb fix               # do it, on a new branch
```

`zomb fix` deletes dead files, removes dead exports and uninstalls unused packages. It needs no AI and no API key. First it runs your own checks (typecheck, lint, test, build) and keeps the ones that pass as its gates. Then it works in batches: after each batch it runs those checks, and if one fails it undoes the batch and retries each item on its own, keeping only what's safe. Every batch is committed on a `zomb/fix-<date>` branch for you to review.

It refuses to run on uncommitted work, and it never touches scripts you may run by hand, tooling packages that configs load by name (ESLint and Prettier configs, `@types/*`, PostCSS and Tailwind plugins), or files that aren't committed yet. It lists those for you instead.

## Shortcuts

With `--since`, zomb also reads the diff for the ways agents make checks pass without fixing anything: new `@ts-ignore` and `eslint-disable`, `.skip` and `.only` tests, deleted tests and assertions, branches on `NODE_ENV === 'test'`, `as any`, and empty `catch` blocks.

## Block new problems in CI

Existing debt shouldn't fail every build. Save it once as a baseline, commit it, and only new findings fail:

```bash
zomb --save-baseline               # writes .zomb/baseline.json
zomb --fail-on high                # exit 1 on new high findings (also: medium, low)
zomb --since main --markdown       # a PR comment
```

On GitHub, the Action comments on every pull request (and updates that comment on each push) and fails the check on new findings:

```yaml
name: zomb
on: pull_request
permissions:
  contents: read
  pull-requests: write
jobs:
  zomb:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0      # zomb compares the PR with where it branched off
      - run: npm ci           # Knip needs your dependencies
      - uses: Open-Dev-Society/zomb@main
        with:
          fail-on: high
```

## Let your agent fix it

`zomb --json` returns tasks like `{ area, severity, action, title, where, how, safe, new }`. `safe: true` marks mechanical clean-up (delete a dead file, uninstall an unused package) that a build can verify. Everything else needs a human yes.

In Claude Code, install the plugin:

```bash
claude plugin marketplace add Open-Dev-Society/zomb
claude plugin install zomb@zomb
```

- **`/zomb-guard`** checks the agent's own change before it says a task is done: new security holes, dead code it left behind, and shortcuts. It fixes what it introduced and ends with `zomb: clean` or what's left and why.
- **`/zomb-clean`** cleans the whole repo on a new branch. It fixes security issues first, then deletes zombie code in small batches, running your typecheck, tests and build after each batch and undoing any batch that breaks something. It asks before anything that changes how the code is organised, and ends with a before/after and the things only you can do (like rotating a leaked key).

Any other agent can follow [skills/zomb-guard/SKILL.md](skills/zomb-guard/SKILL.md) and [skills/zomb-clean/SKILL.md](skills/zomb-clean/SKILL.md).

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
