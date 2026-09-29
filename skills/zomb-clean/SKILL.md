---
name: zomb-clean
description: Clean up an AI-written JS/TS codebase with zomb. Fixes security holes, deletes zombie code and unused packages, and untangles sprawl, checking the build after every step so nothing breaks. Use when the user runs /zomb-clean, asks to clean up or audit a repo, or asks to find dead code, unused packages or security holes.
---

# zomb-clean

`zomb` scans a repo and returns an ordered to-do list. Your job is to work through it on a branch without breaking anything, and to hand back what only a human can do.

## 1. Scan

Run in the repo root:

```bash
zomb --json
```

If `zomb` is not installed, use `npx -y zomb --json`. The output is `{ summary, tasks }`. Each task has `id`, `area` (security, zombie, sprawl, architecture), `severity`, `action`, `title`, `where`, `how` and `safe`.

If the scan says Knip failed, install the project's dependencies with its own package manager (look at the lockfile) and scan again.

Show the user the summary in two or three lines and the plan: security first, then safe clean-up, then the rest only with their yes.

## 2. Get ready

1. Create a branch: `git switch -c zomb-clean/<today's date>`. Never work on main, never push.
2. Find the checks in `package.json` scripts: typecheck (or `npx tsc --noEmit` when there is a tsconfig), lint, test, build.
3. Run them once before changing anything. Note which already fail: those are not yours to fix, and they must not count against your changes.

## 3. Security (tasks with area `security`, highest first)

Fix what code can fix. For each one, change the code, run the checks, commit.

- **Key in the code:** move it to an environment variable, add the name with an empty value to `.env.example`, and tell the user they must rotate the key. It is still in git history.
- **Committed .env file:** `git rm --cached <file>`, add it to `.gitignore`, and tell the user to rotate every value in it.
- **Secret shipped to the browser** (`NEXT_PUBLIC_…`, `VITE_…`): drop the prefix and move the code that uses it to the server (a route handler or server action). If the browser needs the result, call that server code from the client.
- **SQL built from a string:** switch to parameters (tagged `sql` templates, `$queryRaw`, or `?`/`$1` placeholders).
- **Shell command built from a string:** use `execFile` with an argument array, and validate the input.
- **Route with no auth check:** ask whether it is meant to be public. If not, add the auth check the project already uses elsewhere. Never invent a new auth system.
- **Raw HTML from a variable:** render it as text, or sanitize it with the sanitizer the project already has.
- **Vulnerable packages:** run `npm audit fix` (never `--force`), then the checks. List what is left that needs a major upgrade, and ask before doing it.

## 4. Safe clean-up (tasks with `safe: true`)

Do these without asking, in small batches of up to 10 files:

1. Apply the batch: delete the files, uninstall the packages with the project's package manager, or remove the unused exports.
2. Run the checks.
3. If a check that passed before now fails, undo that batch with `git checkout -- .` (and reinstall if you removed packages), then retry the items one at a time. An item that still breaks something is not dead: leave it and report it.
4. Commit the batch, e.g. `zomb-clean: delete 8 unused files (1,240 lines)`.

## 5. Needs a yes (every other task)

Libraries doing the same job, versioned copies, duplicated code, "maybe" routes, import cycles and oversized files all change how the code is organised. List them with one line each and ask which to do. Do one at a time, with the checks after each.

## 6. Report

Run `zomb --json` again and tell the user:

- before → after: security issues, lines of zombie code, unused packages
- the commits you made on the branch
- what only they can do: rotate the keys you moved, decide the "maybe" routes, review and merge the branch

## Rules

- Never print a secret. Refer to it by file and line.
- Never delete a `review` task's file without the user's yes.
- Never run `npm audit fix --force`, never push, never touch deploy settings or rotate keys yourself.
- Keep every commit small enough to review.
