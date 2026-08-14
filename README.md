# dsh-file-claim

File claim / protection for **concurrent DeepSeek Harness (DSH) sessions** working the same workspace.

> **v0.1.0** — first release. A DSH Host plugin that turns the coordination protocol proven in
> `dsh-chat-import`'s `dev/bin/session.mjs` into native tools, lifecycle events, and a write guard.

When several DSH sessions run in parallel against one workspace, they have no awareness of each
other: two sessions can overwrite the same file, a crashed session leaves stale state behind, and a
session that wants to edit a file another session owns can only wait or guess. `dsh-file-claim`
fixes this with a claim/heartbeat/pending-merge protocol:

- **claim / release** — a session declares exclusive ownership of file paths before editing them.
- **heartbeat + stale takeover** — sessions refresh a heartbeat automatically; a crashed session's
  claims expire (default 2h) and can be taken over with `--force`.
- **async pending merge area** — instead of blocking, a session writes its edited content plus the
  git HEAD base into a pending area; after the owner releases, `pending apply` performs a
  **git 3-way merge** (`current × base × pending`), auto-committing when conflict-free.
- **enforcement** — model-facing tools plus a `tools/pre-execute` guard that refuses writes to
  files actively claimed by another session (advisory, cooperative — shell writes cannot be fully
  intercepted).

This is a **gap-filler, not a duplicate**: the DSH host has no built-in cross-session file
protection, and a full scan of 505 `dsh-plugin` topic repositories found zero
file-claim/coordination plugins. The pending merge area is unique in the agent file-lock category.

## Install

```sh
dsh plugin add dsh-file-claim
```

For development / manual verification against a local checkout:

```sh
dsh plugin --profile web add -w link:<repo-path>
```

The plugin is a **pure Host plugin** — no Browser side, no build step.

## Usage

The plugin registers eight model-facing tools (identity is the calling session — no `--as` needed):

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

Lifecycle automation (no manual heartbeat):

- `agent/created` and `agent/status` → auto-register / refresh the session heartbeat.
- `agent/disposed` → auto-release all claims of the departed session.
- `ctx.timer` interval → fallback heartbeat for live sessions.

### Write guard

`tools/pre-execute` denies `write` / `edit` / `bash` / `pwsh` calls whose target path is actively
claimed by **another** session. The denial message names the holder and suggests: wait for
`release_files`, take over with `claim_files(force: true)` once stale, or use `pending_write`.
`read` is **not** intercepted — reading is observation, not modification, and the claim contract
only protects the write surface. Shell-path parsing (`bash`/`pwsh`) is best-effort: quoted
literals and redirection targets are extracted; commands that yield no parseable target pass
through (fail-open).

### Configuration

Passed as plugin config in the bundle (`cordis.patch.yml`):

| Key | Default | Meaning |
| --- | --- | --- |
| `staleMs` | `7200000` (2h) | Heartbeat expiry before a session is considered stale |
| `stateDirName` | `.dsh-file-claim` | Registry + pending area directory under the workspace root |
| `guard` | `true` | Set `false` to disable the pre-execute write guard |
| `heartbeatMs` | `600000` (10min) | Fallback heartbeat interval |

The claim registry and pending area live in `<workspaceRoot>/<stateDirName>/` — recommend adding it
to `.gitignore`. State survives restarts; nothing ever touches `.git/`.

## Pending Merge Area (contract)

Storage layout (under `<workspaceRoot>/<stateDirName>/pending/`):

```
pending/<relpath>/content     new file content to merge
pending/<relpath>/base        git HEAD version at write time (merge base)
pending/<relpath>/meta.json   { pender, claimedBy, at, baseSha }
```

Write conditions: `pending_write` requires the target to be actively claimed by another session —
otherwise write the file directly after `claim_files`. `base` is only recorded when `git HEAD`
contains the path; a missing base is a deliberate non-mergeable entry.

Apply semantics (`pending_apply`): runs `git merge-file` over `current × base × pending`
(three real file snapshots staged in a temp dir). No conflicts → merged content lands on disk and
the entry is cleared. Conflicts → the merged output (with conflict markers) lands on disk and the
entry is **kept** for manual resolution. Missing base → refused, never a blind merge. Active claim
by any session → refused until released.

`release_files` runs an unlock check: pending entries aimed at the released paths (or at the
releasing session) are surfaced in the release output.

## Enforcement boundary (read before relying on it)

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
`index.mjs` is the only host-facing file; `test/` covers both. See `dev/REQUIREMENTS.md` (local,
not committed) and the feasibility study `dev/file-protection-plugin-study.md` for background.

## Design sources

- Feasibility study: `dev/file-protection-plugin-study.md` (local; not committed by policy).
- Requirements: `dev/REQUIREMENTS.md` (local; not committed by policy).
- The protocol being ported: `dev/bin/session.mjs` in [Nwflower/dsh-chat-import](https://github.com/Nwflower/dsh-chat-import).

## License

MIT
