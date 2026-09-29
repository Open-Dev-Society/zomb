---
name: zomb-guard
description: Check your own change with zomb before you say a coding task is done. Catches new security holes, dead code you left behind, and shortcuts like @ts-ignore, eslint-disable, skipped or deleted tests. Use at the end of every coding task in a JS/TS repo, when the user runs /zomb-guard, or before opening a pull request.
---

# zomb-guard

Before you tell the user a task is done, check what your change did to the codebase.

## 1. Scan your change

```bash
zomb --since HEAD --json
```

`--since HEAD` covers your uncommitted work. If you already committed on a branch, use the branch it came from instead (`--since main`). If `zomb` is not installed, use `npx -y zomb`. Only files your change touched are reported, plus packages whose last import you removed.

## 2. Fix what you introduced

Go through `tasks` from the top:

- **security:** fix it now. A key in code moves to an environment variable, and you tell the user to rotate it.
- **shortcuts:** these are the places your change silenced a check instead of fixing it:
  - `@ts-ignore` or `@ts-expect-error`
  - `eslint-disable`
  - `as any`
  - an empty `catch`
  - a `.skip`, `.only` or deleted test
  - a branch on `NODE_ENV === 'test'`

  Remove the shortcut and fix the real problem. If one is truly needed, keep it, add a comment saying why, and tell the user.
- **zombie:** delete the files and exports your change left unused, and uninstall packages you stopped importing.
- **sprawl and architecture:** if you created a second version of something (a `V2` file, a helper that already exists elsewhere, a new library for a job an installed one already does), use the existing one instead.

Run the project's typecheck and tests after fixing, then scan again.

## 3. Report

End with one line: `zomb: clean` if nothing is left. Otherwise list what is left, and why you kept each one.

## Rules

- Never add a suppression, skip a test, or delete a test to make zomb or the checks pass.
- Never print a secret: refer to it by file and line.
