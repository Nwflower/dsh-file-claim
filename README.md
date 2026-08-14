# dsh-file-claim

[![English](https://img.shields.io/badge/lang-English-blue.svg)](README.md) [![简体中文](https://img.shields.io/badge/lang-%E7%AE%80%E4%BD%93%E4%B8%AD%E6%96%87-red.svg)](README.zh-CN.md)

[![npm version](https://img.shields.io/npm/v/dsh-file-claim)](https://www.npmjs.com/package/dsh-file-claim)
[![npm downloads](https://img.shields.io/npm/dm/dsh-file-claim)](https://www.npmjs.com/package/dsh-file-claim)
[![CI](https://github.com/Nwflower/dsh-file-claim/actions/workflows/ci.yml/badge.svg)](https://github.com/Nwflower/dsh-file-claim/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18-green.svg)](package.json)

> **Write in parallel. Never overwrite.**
> File claim / protection for concurrent DeepSeek Harness (DSH) sessions working the same workspace.

When several DSH sessions run in parallel against one workspace, they have no awareness of each
other: two sessions can overwrite the same file, a crashed session leaves stale state behind, and a
session that wants to edit a file another session owns can only wait or guess. `dsh-file-claim`
turns a proven coordination protocol into native DSH tools, lifecycle events, and a write guard —
so parallel agents cooperate instead of clobbering each other.

```text
claim_files({ paths: ["README.md"] })   # "I'm editing this"
write / edit ...                          # writes to files claimed by others are denied
release_files({ paths: ["README.md"] })  # "done — pending edits auto-merge now"
```

## Table of Contents

- [Features](#features)
- [Why](#why)
- [Install](#install)
- [Quick Start](#quick-start)
- [Usage Examples](#usage-examples)
- [Tools](#tools)
- [Commands](#commands)
- [Write Guard](#write-guard)
- [Configuration](#configuration)
- [Audit Log](#audit-log)
- [Pending Merge Area](#pending-merge-area)
- [Enforcement Boundary](#enforcement-boundary)
- [FAQ](#faq)
- [Development](#development)
- [Related Projects](#related-projects)
- [License](#license)

## Features

- 🔒 **claim / release** — a session declares exclusive ownership of file paths before editing
  them; duplicates merge idempotently, directory claims cover descendants, and `'.'` claims the
  whole workspace.
- ❤️ **heartbeat + stale takeover** — heartbeats refresh automatically via agent lifecycle events;
  a crashed session's claims expire (default 2h) and can be taken over with `--force`.
- 🧩 **async pending merge area** — instead of blocking, a session writes its edited content plus
  the git HEAD base into a pending area; when the owner releases, the entry is **auto-merged** via
  a **git 3-way merge** (`current × base × pending`) when conflict-free, or applied manually with
  `pending apply` when it conflicts.
- 🛡️ **write guard** — a `tools/pre-execute` guard refuses writes to files actively claimed by
  another session, with a hint (wait / takeover when stale / pend) and an opt-in commit guard.
- ⚡ **zero automation burden** — `agent/created` / `agent/status` refresh the heartbeat, and
  `agent/disposed` auto-releases every claim of a departed session.
- 📦 **pure Host plugin, zero dependencies** — no Browser side, no build step, `node:` builtins
  only; Windows-friendly.
- 🧾 **audit trail** — every claim / release / takeover / pending mutation is appended as one JSON
  line, for traceability and post-crash reconciliation.

## Why

The DSH host has no built-in cross-session file protection, and a full scan of 505
`dsh-plugin` topic repositories found **zero** file-claim/coordination plugins. The pending merge
area — write your edit now, merge it cleanly once the owner releases — is unique in the agent
file-lock category. This is a gap-filler, not a duplicate.

### Compared with the category

Checked against 11 Claude Code / Codex file-lock and coordination tools (claude-code-file-locks,
parallel-sessions, guardex, agent-orchestrator, blackboard-mcp, mclaude, ruah-orch, knot, …):

| Differentiator | dsh-file-claim | Typical alternatives |
| --- | --- | --- |
| Conflict handling | **async pending area + git 3-way merge** — write now, merge cleanly once the owner releases | wait / deny only ("lock → write → release") |
| Target platform | **DSH-native** — identity, tools, events, guard and slash commands all integrated | Claude Code / Codex hooks; none target DSH |
| Platform support | zero-dependency Node, **Windows-friendly** | Bash/jq/flock solutions lean macOS/Linux; guardex has no native Windows |
| Enforcement | cooperative tool-layer guardrail (fail-open, matching the category's de-facto standard) | hook interception / declarative locks; top tools fall back to worktree isolation |

## Install

```sh
dsh plugin add dsh-file-claim
```

For development / manual verification against a local checkout:

```sh
dsh plugin --profile web add -w link:<repo-path>
```

Requires DSH with `node >= 18` and `git` on `PATH` (used only by the 3-way merge).

## Quick Start

1. **Claim before you write.** Editing files? Call `claim_files` first — it declares exclusive
   ownership so other sessions leave them alone.
2. **Write freely.** Your own claims never block you; writes to files actively claimed by
   *another* session are denied with a hint (wait / takeover when stale / pend).
3. **Busy file? Don't wait — pend.** Use `pending_write` to drop your edited content into the
   pending area (with the git HEAD base). Once the owner calls `release_files`, the entry is
   auto-merged when conflict-free — or run `pending_apply` manually for a clean 3-way merge.
4. **Release when done.** `release_files` clears your claims, auto-merges waiting pending entries,
   and surfaces the ones that need manual attention.

```text
claim_files({ paths: ["README.md", "src/"] })
write / edit ...
release_files({ paths: ["README.md"] })
```

## Usage Examples

**Two sessions, one workspace.** Session A owns `README.md`; session B wants to edit it too:

```text
// Session A
claim_files({ paths: ["README.md"], note: "rewriting the docs" })
write  ...  README.md          // allowed: own claim
release_files({ paths: ["README.md"] })

// Session B — meanwhile
who_claims({ paths: ["README.md"] })          // → claimed by A
write ... README.md                           // → DENIED with a hint
pending_write({ path: "README.md", content: "..." })  // async, no blocking
// When A releases, the entry is auto 3-way merged (or surfaced for manual pending_apply)
```

**Recover from a crashed session.** Session A dies mid-work; its claims expire after `staleMs`
(2h default), then:

```text
claim_status()                      # → A shows [stale]
claim_files({ paths: ["README.md"], force: true })   # take over
```

## Tools

Eight model-facing tools (identity is the calling session — no `--as` needed):

| Tool | Purpose |
| --- | --- |
| `claim_files` | Claim file/dir paths exclusively before editing (`paths`, optional `note`, `force` for stale takeover) |
| `release_files` | Release paths (`paths`) or everything (`all`) |
| `who_claims` | Read-only: who claims given paths |
| `claim_status` | Read-only: session registry, claims, pending area overview, recent audit |
| `pending_write` | Async write: put edited content (+ git HEAD base) into the pending area for a file actively claimed by another session |
| `pending_apply` | 3-way merge `current × base × pending` onto disk; conflict-free auto-clears, conflicts leave markers |
| `pending_show` | Read-only: view one pending entry's meta and content |
| `pending_drop` | Discard one pending entry (no merge) |

## Commands

Human-usable slash commands (same semantics as the tools above — useful when the model is
unavailable, or for shell-bound users). The line after the command name is split quote-aware, so
paths and notes containing spaces work (`--note "multi word note"`). Command runs are recorded in
the session log only, never fed to the model.

| Command | Purpose |
| --- | --- |
| `/claim <path>... [--note <text>] [--force]` | Claim file/dir paths exclusively; `--force` takes over a stale holder |
| `/release [<path>... \| --all]` | Release paths or everything |
| `/claim-status` | Read-only: session registry, claims, pending area overview |

The standalone core also ships a CLI: `node claim.mjs status | audit [n] | claim ...` — same
semantics, no DSH required.

## Write Guard

`tools/pre-execute` denies `write` / `edit` / `bash` / `pwsh` calls whose target path is actively
claimed by **another** session. The denial message names the holder and suggests: wait for
`release_files`, take over with `claim_files(force: true)` once stale, or use `pending_write`.
`read` is **not** intercepted — reading is observation, not modification, and the claim contract
only protects the write surface. Shell-path parsing (`bash`/`pwsh`) is best-effort: only
**redirection targets** and the target arguments of **explicit write commands** are extracted
(pwsh `Set-Content` / `Add-Content` / `Out-File` / `New-Item` / `Copy-Item` / `Move-Item` /
`Remove-Item` / `Rename-Item`; bash `tee` / `dd of=` / `cp` / `mv` / `rm`). Quoted literals are
**never** treated as write targets — they are data, URLs or patterns, not files being written —
and commands that yield no parseable target pass through (fail-open).

With `guardCommit: true`, a `git commit` that explicitly stages paths actively claimed by another
session (`git commit -- <path>` or legacy `git commit <path>`) is also denied; commit messages are
never inspected, and a bare `git commit` (no paths) passes through — its scope cannot be known.

## Configuration

Passed as plugin config in the bundle (`cordis.patch.yml`):

| Key | Default | Meaning |
| --- | --- | --- |
| `staleMs` | `7200000` (2h) | Heartbeat expiry before a session is considered stale |
| `stateDirName` | `.dsh-file-claim` | Registry + pending area directory under the workspace root |
| `guard` | `true` | Set `false` to disable the pre-execute write guard |
| `guardCommit` | `false` | Opt-in: also deny `git commit` that explicitly stages paths actively claimed by another session |
| `heartbeatMs` | `600000` (10min) | Fallback heartbeat interval |

```yaml
- insert:
    - id: dsh-file-claim
      name: dsh-file-claim
      config:
        staleMs: 3600000        # 1h
        guardCommit: true       # also guard explicit git commits
```

The claim registry and pending area live in `<workspaceRoot>/<stateDirName>/` — recommend adding it
to `.gitignore`. State survives restarts; nothing ever touches `.git/`.

## Audit Log

Every business mutation — claim, takeover, release, pending write / apply / drop, prune, drop — is
appended as one JSON line to `<stateDir>/audit.jsonl` (`{ at, tag, type, paths/path, detail }`),
for traceability and post-crash reconciliation. Heartbeats are intentionally **not** logged (noise).
`node claim.mjs audit [n]` prints the latest `n` entries (default 10); `claim_status` always shows
the three most recent. Audit writes are append-only and never block or alter claim semantics; a
failed audit append surfaces a warning line without failing the operation.

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
releasing session) are **auto-merged** when the 3-way merge is conflict-free (content lands on
disk, entry cleared); entries that cannot merge — still occupied, missing base, conflicts, or
missing file — stay pending and are surfaced with manual `pending_apply` / `pending_show` /
`pending_drop` hints.

## Enforcement Boundary

The guard is **advisory / cooperative**, not a mandatory lock: arbitrary shell commands
(`echo > file`, `git checkout`, scripts), external editors, and IDE/git operations bypass the tool
stack entirely. It upgrades "self-discipline via AGENTS.md" to "tool-layer guardrail + model-visible
state", matching the fail-open posture of the whole category.

## FAQ

**Can bash/pwsh writes be fully intercepted?** No. Only redirection targets and the target
arguments of explicit write commands are parsed; arbitrary shell, scripts, external editors and
IDE/git operations bypass the tool stack. That is the documented cooperative boundary, not a bug —
see [Enforcement Boundary](#enforcement-boundary).

**How long until a crashed session's claims expire?** `staleMs`, default 2h. Departing sessions
release automatically via `agent/disposed`, so stale takeover is only a last-resort fallback.

**Does this work across multiple repos?** Yes. The claim root is the workspace resolved from the
session's cwd (`workspaceRegistry`), falling back to cwd — parallel repos are isolated by design.

**Where is state stored?** `<workspaceRoot>/.dsh-file-claim/` (registry, pending area, audit).
Add it to `.gitignore`; it survives restarts and never touches `.git/`.

**Why can't the model see the claim tools?** Model-visible tools depend on the deployment's tool
presentation/restrictions (like every plugin tool). The plugin registers globally via
`ctx.tools.register`, the same path as official tool packages.

**What if a pending entry can't merge?** It stays pending with the reason surfaced (still occupied,
missing base, conflicts, missing file). Use `pending_show` to inspect and `pending_apply` /
`pending_drop` to resolve — nothing is ever blindly merged.

## Development

```sh
npm test        # node --test: claim.mjs unit tests (17) + index.mjs mock-ctx integration (11)
npm pack --dry-run
```

Layout: `claim.mjs` is the zero-dependency pure-logic core (portable, CLI entry retained);
`index.mjs` is the only host-facing file; `test/` covers both. CI runs tests, a bilingual-README
structure sync check, and a pack dry-run.

## Related Projects

- [dsh-chat-import](https://github.com/Nwflower/dsh-chat-import) — the sibling DSH plugin whose
  `session.mjs` coordination protocol this plugin was ported and enhanced from.
- [awesome-dsh-plugin](https://github.com/bruc3van/awesome-dsh-plugin) — the DSH plugin ecosystem
  index (505 repos scanned during this project's research).
- [@deepseek-ai/dsh](https://www.npmjs.com/package/@deepseek-ai/dsh) — the DeepSeek Harness host.

## License

MIT — see [LICENSE](LICENSE).
