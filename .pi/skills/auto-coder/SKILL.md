---
name: auto-coder
description: Autonomous spec-driven development agent for fiat-agent. Syncs DEV_SPEC.md into chapter references, picks the next pending task, implements code, runs checks and tests with up to 3 auto-fix rounds, then updates the task checkbox in the spec and commits. Use when the user says "auto code", "自动开发", "自动写代码", "auto dev", "一键开发", "autopilot", or wants a fully automated spec-to-code workflow.
---

# Auto Coder (fiat-agent-pi / Pi edition)

One trigger completes **read spec → find task → code → verify → update progress**.

Optional modifiers: append a task ID (e.g. `auto code P1-6`) to target a specific task, or `--no-commit` to skip the git commit.

Pipeline:

```text
Sync Spec → Find Task → Implement → Verify (≤3 fix rounds) → Persist
```

Run everything autonomously; pause only at the end for commit confirmation.

Ported from `MODULAR-RAG-MCP-SERVER/.github/skills/auto-coder` (Python/pytest). Same mechanism, TypeScript content layer.

## Environment

| Variable | Meaning | Default |
|---|---|---|
| `FIAT_SPEC_PATH` | Spec — **this is also the progress store** | `<repo>/DEV_SPEC.md` |
| `FIAT_ROOT` | fiat-agent-pi repo root | `/Users/tog/Desktop/project/fiat-agent-pi` |

**`DEV_SPEC.md` is the single state store.** Task status lives in its checkboxes — updating a task means flipping `[ ]` → `[x]` in that file. `PROGRESS.md` under this skill directory is a **derived read-only** view; editing it does nothing.

Companion design docs (read-only, why/detail): Obsidian `法币 agent/法币定制 Agent DEV_SPEC（Pi 版）.md` and `法币 agent/法币定制 Agent 技术方案.md`.

## Reference Map

All files under `.pi/skills/auto-coder/`:

| File | Content | When to read |
|---|---|---|
| `references/01-positioning.md` | Three-layer architecture, L1 vs L2 | **First task, always** |
| `references/02-env-workspace.md` | Runtime, workspace layout, Pi dependency | Setting up / wiring deps |
| `references/03-l1-extensions.md` | Extension list, DI pattern, permission gates | **Any L1 work** |
| `references/04-l2-platform.md` | Platform minimum set, session factory, approval flow | **Any L2 work** |
| `references/05-config.md` | Config schema | Adding config |
| `references/06-dataflow.md` | Two end-to-end flows | Implementing a flow |
| `references/07-testing.md` | Test layers, faux provider recipe | **Writing tests** |
| `references/08-schedule.md` | Task list (source of truth) | Every cycle |
| `references/09-constraints.md` | Iron rules, pitfalls, git discipline | Before any non-trivial change |
| `PROGRESS.md` | Derived progress view (read-only) | Quick status check |

---

## 1. Sync Spec

```bash
node .pi/skills/auto-coder/scripts/sync_spec.mjs
```

The script hashes the spec and skips regeneration when unchanged; it always refreshes `PROGRESS.md`. Output tells you the next task directly.

Status markers in `DEV_SPEC.md`:

| Marker | Status |
|---|---|
| `[ ]` | Not started |
| `[~]` | In progress |
| `[x]` | Done |

Task IDs are `P{stage}-{seq}`. Task identity is its text, so reordering or inserting tasks in the spec never mixes up progress.

## 2. Find Task

Pick the first `[~]`, then the first `[ ]`. If the user gave a task ID, use it directly.

Mark the chosen task `[~]` in `DEV_SPEC.md` **before** writing code, so an interrupted run leaves a visible trace.

Quick-check that predecessor artifacts exist (file level only). On mismatch, warn and continue — stop only if the target task itself is blocked.

## 3. Implement

1. Read the relevant references: architecture → `01`, extensions → `03`, platform → `04`, testing → `07`, constraints → `09`.
2. Extract from spec: inputs/outputs, design principles, file list, acceptance criteria (each stage heading carries a 验收 clause — that is the definition of done).
3. Plan the file list **before** writing any code.
4. Code, following project rules:
   - Spec is the single source of truth; when it conflicts with your instinct, follow the spec and flag the conflict.
   - Config values come from config files, never hardcoded.
   - Match existing codebase patterns.
   - **Pi core is off limits.** Work in L1 extensions and L2 platform code only.
5. Write tests alongside code. Extension tests use the faux provider — see `references/07-testing.md`.
6. Self-review before verifying: all planned files exist, imports resolve, no leftover scaffolding.

## 4. Verify & Auto-Fix

Verify in this order, stopping at the first failure:

```text
1. Type/lint:   npm run check        (biome + tsgo --noEmit)
2. Tests:       npx vitest --run <affected test files>
3. Smoke:       if the task has a manual acceptance step, run it for real
```

Rounds 0–2: on failure, analyze the error, fix, re-run.
Round 3 still failing: **stop** and report — do not keep guessing.

Never weaken a test to make it pass. Never skip `npm run check` because "it is only a type error".

## 5. Persist

1. Flip the task checkbox in `DEV_SPEC.md` to `[x]`.
2. Re-sync so references and progress stay in step:

```bash
node .pi/skills/auto-coder/scripts/sync_spec.mjs
```

3. Show a summary and ask:

```text
✅ [P0-1] 建 fiat-agent 仓库，file: 依赖本地 Pi
   Files: fiat-agent/package.json, .gitignore
   Verify: npm run check clean, 1/1 test passed
   Commit: feat(fiat-agent): [P0-1] scaffold repo with file: deps on pi

   "commit" → git add <explicit paths> + commit
   "skip"   → end
   "next"   → commit + start next task
```

On "next", loop back to step 1.

---

## Iron Rules

1. **Never `git add -A` / `git add .` / `git add -u`.** Multiple pi sessions may be running in this cwd. Stage explicit paths only: `git add <path1> <path2>`.
2. **Never** `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `git commit --no-verify`. These destroy other sessions' in-flight work.
3. Commit only files changed in this session. Before committing, run `git status` and verify.
4. Commit format: `{feat,fix,docs,chore,test,refactor}[(scope)]: <message>`. Reference the task ID.
5. **Never modify Pi core** (`packages/*/src`) to make fiat-agent work.
6. Stop after 3 failed fix rounds. Report, do not guess.
7. Do not flip a task to `[x]` unless its 验收 criterion actually passed with real command output for this session.
8. `DEV_SPEC.md` is the only place progress is recorded; do not create parallel task lists or status files.
