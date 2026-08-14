# dsh-file-claim

[![CI](https://github.com/Nwflower/dsh-file-claim/actions/workflows/ci.yml/badge.svg)](https://github.com/Nwflower/dsh-file-claim/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/Nwflower/dsh-file-claim)](https://github.com/Nwflower/dsh-file-claim/stargazers)
[![node](https://img.shields.io/badge/node-%3E%3D18-green.svg)](package.json)

> **Write in parallel. Never overwrite.**
> File claim / protection for concurrent DeepSeek Harness (DSH) sessions working the same workspace.

When several DSH sessions run in parallel against one workspace, they have no awareness of each
other: two sessions can overwrite the same file, a crashed session leaves stale state behind, and a
session that wants to edit a file another session owns can only wait or guess. `dsh-file-claim`
turns a proven coordination protocol into native DSH tools, lifecycle events, and a write guard —
so parallel agents cooperate instead of clobbering each other.

## ✨ Features

- **claim / release** — a session declares exclusive ownership of file paths before editing them.
- **heartbeat + stale takeover** — sessions refresh a heartbeat automatically; a crashed session's
  claims expire (default 2h) and can be taken over with `--force`.
- **async pending merge area** — instead of blocking, a session writes its edited content plus the
  git HEAD base into a pending area; after the owner releases, `pending apply` performs a
  **git 3-way merge** (`current × base × pending`), auto-committing when conflict-free.
- **write guard** — a `tools/pre-execute` guard refuses writes to files actively claimed by
  another session (advisory, cooperative — shell writes cannot be fully intercepted).
- **zero automation burden** — `agent/created` / `agent/status` refresh the heartbeat, and
  `agent/disposed` auto-releases every claim of a departed session.
- **pure Host plugin, zero dependencies** — no Browser side, no build step, `node:` builtins only.

## Why

The DSH host has no built-in cross-session file protection, and a full scan of 505
`dsh-plugin` topic repositories found **zero** file-claim/coordination plugins. The pending merge
area — write your edit now, merge it cleanly once the owner releases — is unique in the agent
file-lock category. This is a gap-filler, not a duplicate.

## Install

```sh
dsh plugin add dsh-file-claim
```

For development / manual verification against a local checkout:

```sh
dsh plugin --profile web add -w link:<repo-path>
```

## Quick Start

1. **Claim before you write.** Editing files? Call `claim_files` first — it declares exclusive
   ownership so other sessions leave them alone.
2. **Write freely.** Your own claims never block you; writes to files actively claimed by
   *another* session are denied with a hint (wait / takeover when stale / pending).
3. **Busy file? Don't wait — pend.** Use `pending_write` to drop your edited content into the
   pending area (with the git HEAD base). Once the owner calls `release_files`, run `pending_apply`
   for a clean 3-way merge.
4. **Release when done.** `release_files` clears your claims and runs an unlock check that
   surfaces any pending entries waiting on you.

```text
claim_files({ paths: ["README.md", "src/"] })
write / edit ...
release_files({ paths: ["README.md"] })
```

## Tools

Eight model-facing tools (identity is the calling session — no `--as` needed):

| Tool | Purpose |
| --- | --- |
| `claim_files` | Claim file/dir paths exclusively before editing (`paths`, optional `note`, `force` for stale takeover) |
| `release_files` | Release paths (`paths`) or everything (`all`) |
| `who_claims` | Read-only: who claims given paths |
| `claim_status` | Read-only: session registry, claims, pending area overview |
| `pending_write` | Async write: put edited content (+ git HEAD base) into the pending area for a file actively claimed by another session |
| `pending_apply` | 3-way merge `current × base × pending` onto disk; conflict-free auto-clears, conflicts leave markers |
| `pending_show` | Read-only: view one pending entry's meta and content |
| `pending_drop` | Discard one pending entry (no merge) |

## Write Guard

`tools/pre-execute` denies `write` / `edit` / `bash` / `pwsh` calls whose target path is actively
claimed by **another** session. The denial message names the holder and suggests: wait for
`release_files`, take over with `claim_files(force: true)` once stale, or use `pending_write`.
`read` is **not** intercepted — reading is observation, not modification, and the claim contract
only protects the write surface. Shell-path parsing (`bash`/`pwsh`) is best-effort: quoted
literals and redirection targets are extracted; commands that yield no parseable target pass
through (fail-open).

## Configuration

Passed as plugin config in the bundle (`cordis.patch.yml`):

| Key | Default | Meaning |
| --- | --- | --- |
| `staleMs` | `7200000` (2h) | Heartbeat expiry before a session is considered stale |
| `stateDirName` | `.dsh-file-claim` | Registry + pending area directory under the workspace root |
| `guard` | `true` | Set `false` to disable the pre-execute write guard |
| `heartbeatMs` | `600000` (10min) | Fallback heartbeat interval |

The claim registry and pending area live in `<workspaceRoot>/<stateDirName>/` — recommend adding it
to `.gitignore`. State survives restarts; nothing ever touches `.git/`.

## Pending Merge Area

Storage layout (under `<workspaceRoot>/<stateDirName>/pending/`):

```text
pending/<relpath>/content     new file content to merge
pending/<relpath>/base        git HEAD version at write time (merge base)
pending/<relpath>/meta.json   { pender, claimedBy, at, baseSha }
```

Write conditions: `pending_write` requires the target to be actively claimed by another session —
otherwise write the file directly after `claim_files`. `base` is only recorded when `git HEAD`
contains the path; a missing base is a deliberate non-mergeable entry.

Apply semantics (`pending_apply`): runs `git merge-file` over `current × base × pending` (three
real file snapshots staged in a temp dir). No conflicts → merged content lands on disk and the
entry is cleared. Conflicts → the merged output (with conflict markers) lands on disk and the
entry is **kept** for manual resolution. Missing base → refused, never a blind merge. Active claim
by any session → refused until released.

`release_files` runs an unlock check: pending entries aimed at the released paths (or at the
releasing session) are surfaced in the release output.

## Enforcement Boundary

The guard is **advisory / cooperative**, not a mandatory lock: arbitrary shell commands
(`echo > file`, `git checkout`, scripts), external editors, and IDE/git operations bypass the tool
stack entirely. It upgrades "self-discipline via AGENTS.md" to "tool-layer guardrail + model-visible
state", matching the fail-open posture of the whole category.

## Development

```sh
npm test        # node --test: claim.mjs unit tests (16) + index.mjs mock-ctx integration (6)
npm pack --dry-run
```

Layout: `claim.mjs` is the zero-dependency pure-logic core (portable, CLI entry retained);
`index.mjs` is the only host-facing file; `test/` covers both.

## License

MIT
