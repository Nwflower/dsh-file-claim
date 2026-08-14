# dsh-file-claim

File claim / protection for **concurrent DeepSeek Harness (DSH) sessions** working the same workspace.

> Status: **planning** — repository skeleton only. No plugin behavior yet. See `dev/REQUIREMENTS.md` (local, not committed) and the study `dev/file-protection-plugin-study.md` for the research and feasibility assessment behind this project.

## What it will do

When several DSH sessions run in parallel against one workspace, they currently have no awareness of each other: two sessions can overwrite the same file, a crashed session leaves stale state behind, and a session that wants to edit a file another session owns can only wait or guess. `dsh-file-claim` turns the coordination protocol proven in the `dsh-chat-import` repo (`dev/bin/session.mjs`) into a native DSH Host plugin:

- **claim / release** — a session declares exclusive ownership of file paths before editing them.
- **heartbeat + stale takeover** — sessions refresh a heartbeat; a crashed session's claims expire and can be taken over with `--force`.
- **async pending merge area** — instead of blocking, a session writes its edited content plus the git HEAD base into a pending area; after the owner releases, `pending apply` performs a **git 3-way merge** (`current × base × pending`), auto-committing when conflict-free.
- **enforcement** — model-facing tools (`claim_files` / `release_files` / `who_claims` / …) and a `tools/pre-execute` guard that refuses writes to files actively claimed by another session (advisory, cooperative — shell writes cannot be fully intercepted).

This is a **gap-filler, not a duplicate**: the DSH host has no built-in cross-session file protection, and a full scan of 505 `dsh-plugin` topic repositories found zero file-claim/coordination plugins. The pending merge area is unique in the agent file-lock category.

## Install (once implemented)

```sh
dsh plugin add dsh-file-claim
```

## Design sources

- Feasibility study: `dev/file-protection-plugin-study.md` (local; not committed by policy).
- Requirements: `dev/REQUIREMENTS.md` (local; not committed by policy).
- The protocol being ported: `dev/bin/session.mjs` in [Nwflower/dsh-chat-import](https://github.com/Nwflower/dsh-chat-import).

## License

MIT
