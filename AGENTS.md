# PocketRisu agent guidance

## Pnya downstream checkout

- Before changing this downstream checkout, read the repository-root `PNYA.md`.
- Keep local `main` as a fast-forward-only mirror of official `origin/main`; downstream work belongs on branches based on `pnya/main`.
- Treat `pnya/main` as the verified rolling baseline. Use scoped `feat/*`, `fix/*`, or `sync/*` branches and advance it only after the checks in `PNYA.md` pass.
- Never push to official `origin`, and do not rebase or force-push a published `pnya/main`.
- Preserve PocketRisu-native behavior and avoid copying RisuAI internals when the platform boundary differs.

## Validation

- Run focused tests for the changed surface.
- Run `pnpm check` and the relevant Vitest suites before advancing `pnya/main`.
- Record source inclusion, automated, smoke, and device-backed verification separately.
