# zomb

Find the zombie code in your repo.

Coding agents write code faster than teams read it. Some of it is dead. Some of it is alive and running, but nobody on the team has ever read it: that's zombie code. `zomb` maps every JS/TS file on two axes, **is it used?** and **has a human understood it?**, and tells you what to delete first.

```bash
npx zomb              # run inside any git repo
npx zomb path/to/repo --out report.html
```

One command writes a single HTML report. Your code never leaves your machine.

|                    | **Unused**         | **Used**        |
| ------------------ | ------------------ | --------------- |
| **Understood**     | Safe to delete     | Healthy         |
| **Not understood** | **Delete first**   | **Zombie code** |

## How it scores

- **Used:** [Knip](https://knip.dev) finds no import of the file, and no other file in the repo names its path (so `action.yml` entry points and `package.json` scripts count as used). Files in dot-folders like `.claude/` and `.github/`, and `*.config.*` files, always count as used. Install dependencies first: Knip needs them to read your config files.
- **Understood:** the share of lines last written by a human (`git blame`), plus half of the agent-written lines when their latest PR had a real human review. 50% or more counts as understood.
- **Agents** are detected from commit authors and `Co-Authored-By` trailers (Claude Code, Cursor, Copilot, Codex, Devin, Jules, Aider and others).
- **Reviews** come from your last 100 merged GitHub PRs, using `GITHUB_TOKEN`, `GH_TOKEN` or `gh auth token`. A PR approved within 2 minutes of its last commit with no comments counts as a rubber stamp. Pass `--no-github` to skip this.

The map is per file and per folder. It never scores people.

## Develop

```bash
npm install
npm test
node src/cli.js ../some-repo
```

MIT
