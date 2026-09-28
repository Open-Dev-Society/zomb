# zomb

Find the zombie code in your repo.

Zombie code is code that sits in your codebase but isn't in use: files nothing imports, files only their own tests keep alive, and pages or API routes nothing links to. Coding agents leave a lot of it behind. `zomb` finds it, tells you how many lines you can delete, and which of it nobody on the team even understands.

```bash
npx zomb              # run inside any git repo
npx zomb path/to/repo --out report.html
```

One command writes a single HTML report. Your code never leaves your machine.

What you get:

- **Zombie code:** every file that isn't in use, biggest first, with why (nothing imports it, or only tests do) and who wrote it.
- **Maybe zombie:** pages and API routes nothing in the repo links to or calls. Check your analytics before deleting these.
- **Read these first:** code that *is* in use but nobody has read, ranked by what it can break: how many files depend on it, what it touches (payments, auth, database, secrets, shell, public endpoints) and how often it needed fixes lately. The list fits in about an hour of reading.
- **Who writes your new code:** the share of new lines each month that agents wrote.
- **Copy-paste:** blocks of code that appear twice, and helpers defined in more than one file.
- **Review speed:** PRs approved faster than anyone can read them (for example, 1,240 lines approved 30 minutes after the last commit, with no comments).

|                    | **Not in use (zombie)**      | **In use**      |
| ------------------ | ---------------------------- | --------------- |
| **Understood**     | Zombie, someone knows it     | Healthy         |
| **Not understood** | **Zombie, nobody knows it**  | **Unread code** |

## How it scores

- **Zombie (not in use):** [Knip](https://knip.dev) finds no import of the file and no other file in the repo names its path, or only tests import it. Files started by path (`action.yml` entry points, `package.json` scripts), files in dot-folders like `.claude/` and `.github/`, and `*.config.*` files always count as in use. Install dependencies first: Knip needs them to read your config files.
- **Maybe zombie:** a Next.js page or API route whose URL appears nowhere else in the repo. Webhooks, auth callbacks, crons and SEO files are skipped, and so are API routes in repos that are only an API.
- **Understood:** the share of lines last written by a human (`git blame`), plus half of the agent-written lines when their latest PR had a real human review. 50% or more counts as understood.
- **Agents** are detected from commit authors and `Co-Authored-By` trailers (Claude Code, Cursor, Copilot, Codex, Devin, Jules, Aider and others).
- **Reviews** come from your last 100 merged GitHub PRs, using `GITHUB_TOKEN`, `GH_TOKEN` or `gh auth token`. A PR approved within 2 minutes of its last commit, or faster than 1,000 lines an hour, with no comments counts as a rubber stamp. Pass `--no-github` to skip this.

The map is per file and per folder. It never scores people.

## Develop

```bash
npm install
npm test
node src/cli.js ../some-repo
```

MIT
