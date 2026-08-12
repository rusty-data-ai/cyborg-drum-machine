# Contributing / version-control protocol

Agreed with the project owner on 2026-08-12. All sessions (human or agent) follow this.

## Branches

- **`chris-dev` is the trunk** — the main development line and the GitHub default
  branch. All day-to-day work lands here.
- **`main` is the production branch** and is protected by convention: it is only
  updated by merging `chris-dev` into it, and **only with the owner's explicit
  approval** (a merge to `main` is a release; once Cloudflare Pages is wired it
  triggers a production deploy via `.github/workflows/ci.yml`).
- No long-lived feature branches: commit directly to `chris-dev`. If a branch is
  ever needed for an experiment, branch off `chris-dev` and merge back promptly.

## Commits

- One **atomic (single logical) change** per commit, committed frequently.
- Messages: concise imperative subject, plus a body explaining **what changed and
  why** when the subject alone doesn't carry it. Reference the GitHub issue
  (e.g. `(#6)`) when the work belongs to one. Do not use `Closes #N` — close
  issues explicitly with a delivery comment instead.
- Do not squash away granular history unless the owner asks.

## Pushing

- Push to `origin chris-dev` **after each coherent feature/piece of work** is
  committed and green (tests passing). Don't leave finished work unpushed.

## Quality gates (before a push counts as "green")

- `(cd web && npm test)` — unit suite
- `(cd web && npx playwright test)` — e2e suite
- `(cd web && npm run build)` and lint clean
- `(cd worker && npm test)` — when the worker is touched
