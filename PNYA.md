# Pnya PocketRisu downstream

This file describes the personal PocketRisu downstream carried by `pnya/main`. It is intentionally absent from the clean official `main` branch.

## Repository model

| Name | Role |
|---|---|
| `origin/main` | Official PocketRisu source of truth; fetch only |
| `main` | Local fast-forward-only mirror of `origin/main` |
| `pnya/main` | Verified, usable personal downstream and normal checkout |
| `fork/pnya/main` | Published personal downstream after the personal fork is prepared |
| `sync/YYYY-MM-DD-<upstream-sha>` | Temporary official-update integration branch |
| `feat/*`, `fix/*` | Scoped downstream work branches |

The canonical workspace path `platforms/PocketRisu` normally checks out `pnya/main`. Linked worktrees are temporary checkouts; branch and remote refs are authoritative.

`origin` is the official repository and must never receive pnya pushes. The personal repository uses the remote name `fork`. After publication, `pnya/main` tracks `fork/pnya/main`, while `main` continues to track `origin/main`.

## Source-included downstream surface

The downstream currently carries source for these bounded host capabilities:

- V3 plugin principals, capabilities, RPC hardening, group-chat handling, and context resources
- owned Inlay lifecycle, background ownership checks, device cache, and atomic attachment/read/metadata operations
- committed-message query and event surfaces
- PixAI artifact storage, secure download, installation, session, inference, and V3 facade support

This list records source inclusion only. Automated, smoke, and device-backed verification are separate claims recorded by a release record in the outer workspace.

## Normal feature work

1. Confirm `platforms/PocketRisu` is on a clean `pnya/main` and read `AGENTS.md` plus this file.
2. Create a narrowly named `feat/*` or `fix/*` branch from `pnya/main`.
3. Implement the approved public contract using PocketRisu-native server, WebKit, and mobile boundaries.
4. Run focused tests, then the repository checks appropriate to the changed surface.
5. Fast-forward `pnya/main` only after review and verification.

Do not commit downstream work directly to `main`. Do not broaden official synchronization into unrelated refactoring.

## Official synchronization

1. Fetch the official repository and fast-forward local `main` to `origin/main` without rewriting history.
2. Create `sync/YYYY-MM-DD-<upstream-sha>` from the current verified `pnya/main`.
3. Merge `main` into the sync branch and resolve conflicts as the smallest union of current upstream behavior and the documented pnya contract.
4. Run the focused custom tests, `pnpm check`, the relevant Vitest suites, and a production build when release evidence requires it.
5. Advance `pnya/main` only when the sync branch is verified. Keep `pnya/main` unchanged on failure.

Published `pnya/main` history is append-only: do not rebase or force-push it.

## Verification vocabulary

- `source included`: implementation is present in the branch
- `automated`: relevant automated checks passed
- `smoke`: the real application flow was exercised
- `device-verified`: provider or device-backed behavior was exercised

Never infer complete compatibility from ancestry, a focused test, `pnpm check`, or a production build alone.

## Preserved references

No currently registered PocketRisu topic branch contains commits that are absent from `pnya/main`. Historical branch names may be removed after containment is rechecked; `pnya/main` remains the recovery baseline.

## Publishing and outer workspace

- Pushes, annotated tags, first publication, and outer gitlink changes require explicit user authorization.
- Before any GitHub write, confirm the connected account is `pnya2021`.
- Prepare and verify the personal PocketRisu fork before adding the `fork` remote.
- Publish the platform commit before updating the outer workspace gitlink.
- The outer workspace release record owns exact SHAs, merge parents, test evidence, known limitations, and tag readback; do not put volatile release SHAs in this file.
