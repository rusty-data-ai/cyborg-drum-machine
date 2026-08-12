# Accounts & per-user model persistence — plan

Sections 1–8 are the original design (issue #4). Implementation status lives
in [§9](#9-implementation-status--go-live-runbook): Phase 0 is shipped and
Phase 1 is code-complete but **deploy-gated on owner credentials**.

Today a user's personal model — KNN
examples in IndexedDB (`web/src/lib/knn.ts`), tuned settings
(`web/src/lib/settings.ts`), their beats — lives in one browser. Clear site
data or switch devices and the "AI that learned your sounds" is gone. This
plan adds an account under which that data persists and keeps improving,
without breaking the two constraints the app was built on: **the product
promise that audio never leaves the browser** (README, design.md, the App
footer) and **the Cloudflare free tier** (docs/deployment.md). The app has no
backend today; every server-side gram below has to justify itself.

## 1. Auth approach

Constraint set: runs on Cloudflare Workers free tier, no monthly bill, works
for a casual music-toy audience (no password manager assumptions), and has a
credible account-recovery story — this account *guards a model the user spent
time teaching*, losing it is the exact failure we're building against.

| | Passkeys / WebAuthn | OAuth (GitHub + Google) | Magic-link email |
|---|---|---|---|
| Implementation effort | High: ceremony parsing, challenge storage, attestation options, cross-device UX | Low: 2 redirects + token exchange per provider | Medium: token issue/verify + an email sender |
| Extra vendor | none | Google/GitHub (free, stable) | **Email API required** — free tiers are thin (Resend 100/day; MailChannels' free Workers integration ended 2024); deliverability is a real tax |
| Account recovery | **Weak alone**: device lost = passkey lost; needs a fallback method anyway | Delegated to provider (their recovery flows are better than anything we'd build) | The email account *is* the recovery path |
| Multi-device UX | Good on one platform ecosystem; cross-ecosystem still clunky | Sign in with the same provider anywhere | Fine, but a mail round-trip per new device |
| Workers library options | `@simplewebauthn/server` (works on Workers) | hand-rolled (~150 lines/provider) or `arctic`/`openauth` | hand-rolled tokens + sender SDK |
| Free-tier fit | ✓ (CPU-light) | ✓ | ✓ Workers-side; ✗ depends on the sender's free tier |

**Session strategy** (applies to whichever auth wins): server-side sessions in
**D1**, referenced by an `HttpOnly; Secure; SameSite=Lax` cookie carrying a
random 128-bit id. Not stateless JWTs (revocation and account-deletion should
actually work), and **not KV-backed sessions**: KV's 1k writes/day is the
scarcest number on the whole free tier — session creation alone would burn it
at ~500 logins/day, while D1 has 100k row writes/day (§6). Sessions live 90
days, sliding.

**Recommendation: OAuth with Google + GitHub, cookie + D1 sessions.**
Rationale: smallest code surface with the *strongest* recovery story
(delegated), no email vendor, and it matches the audience (everyone has one of
the two). Passkeys are the better long-term ceremony but need a fallback
method regardless — so they arrive later *as an addition on top of* OAuth
accounts, not as the foundation. Magic-link loses on the extra vendor + spam
folder risk for zero UX gain over "Sign in with Google".

## 2. What syncs — and the privacy line

Exactly three things sync, all opt-in:

1. **KNN profile examples**: 128-d embedding + label + `modelVersion` +
   `createdAt` + the per-example `modelProbs` added by the teach-flow work
   (issue #3 / `UserExample` in web/src/lib/knn.ts). Includes
   correction-sourced examples — they're ordinary `UserExample`s.
2. **Settings**: the `AppSettings` object (web/src/lib/settings.ts) — six
   clamped numbers; the existing parser already survives junk, so it also
   survives a stale synced copy.
3. **Saved beats**: the compact versioned binary from `web/src/lib/share.ts`
   is the wire format (≤ 197 bytes + a user-given name). The share-URL feature
   itself stays zero-backend and unchanged.

**Never raw audio.** No recordings, no calibration takes, no PCM of any kind —
this is the standing product promise and it stays true verbatim.

- **UI phrasing**: the sync toggle says what crosses the wire in plain terms —
  *"Sync your profile: the sound-fingerprints (lists of numbers the AI derives
  from your taught examples), your settings, and your saved beats. Your audio
  itself never leaves this browser."* Embeddings are derived features, not
  recordings, and the copy must make that distinction rather than hide behind
  it.
- **Opt-in**: off by default; the app is fully functional signed-out, forever.
  Signing in does not start syncing; the toggle does.
- **Export**: one button downloads everything the server has for you as a JSON
  file (same format as Phase 0's local export, §7 — so export exists even
  before the backend does).
- **Deletion**: account deletion is a real `DELETE` of all rows (users,
  sessions, examples, settings, beats) in one transaction, confirmed in UI.
  Tombstones (§3) are for sync convergence, not retention: a deleted account
  keeps nothing, tombstones included.

## 3. Schema + conflict/versioning strategy

**D1, not KV.** The access pattern is "all rows for user X, filtered by
`modelVersion`, with individual deletes and merges" — relational, small, and
transactional. KV would force whole-profile blobs (read-modify-write races
between two devices lose data) or one key per example (listing = O(n) reads,
and KV's 1k writes/day dies first). KV's one advantage — read latency — is
irrelevant at one sync per page load. D1 it is.

```sql
CREATE TABLE users (
  id          TEXT PRIMARY KEY,          -- uuidv4
  provider    TEXT NOT NULL,             -- 'google' | 'github'
  provider_id TEXT NOT NULL,
  email       TEXT,
  created_at  INTEGER NOT NULL,
  UNIQUE (provider, provider_id)
);

CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,           -- random 128-bit, cookie value
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE examples (
  uuid          TEXT PRIMARY KEY,        -- client-generated uuidv4 (see below)
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  model_version TEXT NOT NULL,           -- mirrors KnnProfile.load filtering
  label         TEXT NOT NULL,           -- DrumClass
  embedding     BLOB NOT NULL,           -- 128 × float32 LE = 512 B
  model_probs   BLOB,                    -- 5 × float32 = 20 B; NULL for legacy rows
  created_at    INTEGER NOT NULL,
  deleted_at    INTEGER                  -- tombstone; NULL = live
);
CREATE INDEX examples_user_version ON examples (user_id, model_version);

CREATE TABLE settings (
  user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  json       TEXT NOT NULL,              -- AppSettings; client clamps on read anyway
  updated_at INTEGER NOT NULL            -- last-write-wins
);

CREATE TABLE beats (
  uuid       TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  payload    TEXT NOT NULL,              -- share.ts base64url (versioned codec)
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);
```

**Global IDs.** Local example ids are IndexedDB autoincrement integers —
per-device, meaningless globally, and they collide across devices. They cannot
be sync keys. Fix: each example gains a client-generated `uuid` field (new
rows at creation; existing rows lazily, on first sync). The integer id stays
as the local primary key (undo/chip-delete keep working untouched); the sync
layer translates by uuid. This is a schemaless IndexedDB store — adding the
field needs no migration, same as `modelProbs` did.

**Conflict semantics.**
- *Examples*: append-only set with deletions. Merge = union by uuid; a
  tombstone beats a live row (deleting on your phone deletes on your laptop,
  even if the laptop was offline). No updates-in-place exist, so no true
  conflicts can.
- *Settings*: single blob, last-write-wins on `updated_at`. Worst case a
  slider regresses; acceptable at this stakes level.
- *Beats*: same regime as examples (uuid + tombstone). Name edits: LWW.

**Model versioning.** Examples are stored per `model_version`, mirroring the
client (`KnnProfile.load` drops non-matching versions; docs/design.md +
docs/deployment.md describe the invalidation strategy). When a new model
ships (`beatbox.json` bumps): the server does nothing — clients simply read
and write rows for the new version, and old-version rows go cold. Server
retention rule: keep the current and previous version's rows; a scheduled
purge deletes older versions 90 days after they go cold (users who return
after that re-teach, which they'd have to do anyway — embeddings from a
retired model are unusable by design).

**Sync cadence.** Pull once on app load (and on sign-in); push on change,
debounced ~10 s (a teach session writes in one batch, not per capture).
IndexedDB remains the local source of truth: the app never blocks on the
network, works fully offline/signed-out, and reconciles on the next load.
No live two-device merging beyond the rules above — this is backup/roaming,
not Figma.

## 4. "Your own unique model" beyond KNN

How does the personal model deepen as a user keeps teaching and correcting?

| | (a) KNN, growing + pruned | (b) Per-user linear head, trained in-browser | (c) Server-side fine-tuning |
|---|---|---|---|
| Quality path | Good to ~50 ex/class; k=5 vote saturates, outliers linger | Learns feature *weights*, not just neighbours; strictly more capacity on the same 128-d embeddings | Highest ceiling (adapts the backbone) |
| Compute | zero (microseconds/hit) | ~ms per training pass in JS; runs on profile change, off the hot path | GPU minutes per user |
| Server cost | storage only | storage only (+0.8 KB weights) | **No free-tier path**: Workers has 10 ms CPU/invocation and no GPU; would need paid compute |
| Privacy | embeddings only | embeddings only | embeddings only *if* trained on stored embeddings; anything more re-opens the audio promise |
| Verdict | keep as foundation | **recommended next step** | rejected |

**(b) concretely**: multinomial logistic regression over the stored
embeddings, 6 classes × (128 weights + 1 bias) = 774 float32 ≈ **3.1 KB** —
synced like any other profile data (one more column or a `heads` row keyed by
`model_version`). Training is a few hundred gradient steps over ≤ ~300
examples: well under a second of JS, no worker thread needed, retrained
whenever the profile changes. Zero server compute.

**Interaction with the blend** (`web/src/lib/blend.ts`): the head produces a
`Record<DrumClass, number>` — the same shape as the KNN vote — so it slots
into `blendProbs` as a drop-in replacement for (or an average with) `knnVotes`
once the profile is big enough to train on. The alpha ramp
(`min(profileWeight, size/24)`) and the clap/tom eligibility gate
(`MIN_KNN_EXAMPLES`) stay exactly as they are; rejection logic is untouched.
Gate the switchover on measured benefit: the leave-one-out evaluator from the
teach-flow work (`web/src/lib/profileEval.ts`) can score KNN vs head on the
user's own examples and use whichever wins — the same honesty rules apply.

**Interaction with model versioning**: head weights are functions of the
embedding space, so they carry `model_version` and die with it, exactly like
examples. Nothing new to invent.

**Recommendation**: ship (a) as-is with two hygiene rules once sync exists
(per-class cap ~64, newest-first; drop exact-duplicate embeddings), and build
(b) as Phase 3 once profiles above ~40 examples are common. Reject (c) — the
cost/benefit is upside-down while inference is 2.3 ms client-side, and the
free tier cannot express it anyway.

## 5. Migration from anonymous profiles

**First sign-in on a device with existing local data** (the common case —
everyone starts anonymous): prompt once, defaulting to keep:

- *"Keep this device's taught examples and merge them into your account"*
  (default) → local rows get uuids, upload, server-side union by uuid.
  Dedup on merge: same label + identical embedding bytes → one row (protects
  against the same export being imported twice); no fuzzy dedup in v1.
- *"Replace with my account's profile"* → local store cleared, server pulled.

**Fresh device, existing account**: sign-in pulls everything down; examples
are written into IndexedDB with fresh local autoincrement ids and their
server uuids in the new field (the §3 remapping consequence: integer ids are
assigned per-device and never travel). Settings apply through the existing
clamping parser; beats appear in a "my beats" list.

Sign-out leaves local data in place (it's the user's device and the app must
keep working); an explicit "remove my data from this device" action covers
shared machines.

## 6. Cost analysis

Free-tier quotas (verified against Cloudflare's published limits,
**2026-07-28** — recheck at implementation; they change):
Workers Free **100k requests/day** (10 ms CPU each); D1 Free **5 GB storage,
5M rows read/day, 100k rows written/day** (a row counts per row scanned or
written, size-irrelevant); KV Free (unused in this design) 1 GB, 100k
reads/day, **1k writes/day**.

**Bytes per user.** One example as BLOBs: 512 B embedding + 20 B modelProbs +
~36 B uuid + ~30 B label/version/timestamps ≈ **~600 B**. (JSON-number
encoding of the same embedding is ~8 chars/float ≈ 1 KB *for the embedding
alone* — 2× storage and slower parses; store float32 BLOBs.) A heavy profile
of 100 examples ≈ 60 KB; settings ≈ 0.2 KB; 20 saved beats ≈ 6 KB; head
weights 3.1 KB → **call it ≤ 70 KB/user**.

| Scale | Storage (≤70 KB/u) | Worker req/day¹ | D1 rows read/day² | D1 rows written/day³ |
|---|---|---|---|---|
| 100 users | 7 MB | ~80 | ~2.9k | ~640 |
| 1k users | 70 MB | ~800 | ~29k | ~6.4k |
| 10k users | 700 MB | ~8k | ~290k | **~64k** |
| free quota | 5 GB | 100k | 5M | 100k |

¹ 20% DAU × (1 pull + ~3 debounced pushes)/day. ² pull scans ≤ ~140 rows
(examples + settings + beats + session). ³ ~30 example inserts + session +
settings writes per active day — teach-heavy assumption on purpose.

**First quota that breaks: D1 rows written/day, at roughly 10k–15k users** —
a spike day where ~2k active users each teach a fresh ~48-example profile is
~96k row writes on its own (D1 counts rows, so batching inserts into one
statement does not reduce the count). Workers requests break an order of
magnitude later. Storage never breaks at these scales. The failure mode is
soft (sync pauses until 00:00 UTC; the app itself is unaffected — IndexedDB
is the source of truth), and the fix is Workers Paid at $5/mo — consistent
with docs/deployment.md, where the same $5 is the first realistic invoice for
the share-link backend.

## 7. Phased rollout

Each phase ships alone and is worth having alone.

**Phase 0 — profile export/import as a file. No backend, no account.**
Buttons in the Teach panel: export downloads
`beatbox-profile-YYYYMMDD.json` `{formatVersion, modelVersion, examples:[{uuid,
label, embedding, modelProbs?, createdAt}], settings, beats?}`; import merges
by uuid (assigning uuids to legacy rows is this phase's only data change).
Solves backup and manual device transfer *today*, and its format doubles as
the sync/export wire format later.
*Risks*: format becomes a de-facto API — version it from day one.
*Kill/rollback*: none needed; purely local, remove the buttons.

**Phase 1 — accounts + profile sync (opt-in).** OAuth per §1, D1 per §3,
examples-only sync, export + delete-account from day one (§2).
*Risks*: privacy copy must land right (embeddings-not-audio); OAuth secrets
handling in CI; abuse of free storage (mitigate: per-user example cap ~1,000
rows, payload size caps, Turnstile on auth if needed).
*Kill/rollback*: feature-flag sync off; server data remains exportable, then
wipe on a sunset date. Local experience is unchanged by construction.

**Phase 2 — settings + saved beats sync.** Small additive tables (§3), LWW
settings, named beats list in the UI.
*Risks*: LWW clobber surprises (mitigate: only push settings the user
actually changed this session); beats list needs its own delete UI.
*Kill/rollback*: stop syncing these tables; share URLs (zero-backend) still
cover beat portability.

**Phase 3 — per-user head (§4b).** Train in-browser, sync 3.1 KB weights,
gate on the LOO evaluator beating KNN for that user.
*Risks*: regression for small/weird profiles — the gate is the mitigation;
added client complexity in the blend path.
*Kill/rollback*: flag off head usage in `blendProbs`; KNN path is untouched
underneath.

## 8. Open questions (for implementation issues)

- Account linking: same person arrives via Google today, GitHub tomorrow —
  link by verified email, or keep separate accounts with an explicit merge?
- Are 128-d voice-derived embeddings personal data under GDPR? Assume yes
  (they're derived from voice): does that demand anything beyond the
  export/delete story — e.g. a DPA page, EU data location for D1?
- Retention of the *previous* model version's rows: is 90 days right, and
  should users be told before a purge?
- Should correction-sourced examples be flagged (`source: 'correction'`) in
  the schema for future quality weighting, or is provenance noise?
- Per-user caps and rate limits: exact numbers, and whether to surface "profile
  full — prune?" in the teach UI.
- Sessions: is 90-day sliding right for a toy? Do we want a "sign out
  everywhere" button in v1?
- When Phase 3 lands, does the head sync *replace* example sync for users at
  the cap (weights-only roaming), or always ride alongside?

## 9. Implementation status & go-live runbook

### Status

- **Phase 0 — shipped** (issue #5): Teach-panel export/import of
  `beatbox-profile-YYYYMMDD.json`. Codec + merge live in
  `web/src/lib/profileFile.ts` (`formatVersion: 1`; unknown versions rejected
  whole); examples carry client-generated uuids (`web/src/lib/uuid.ts`), with
  legacy IndexedDB rows upgraded lazily on profile load — no migration, same
  mechanism as `modelProbs`. Import refuses files from a different
  `modelVersion` (embeddings don't survive a model bump) and applies imported
  settings through the existing clamping parser.
- **Phase 1 — code-complete, deploy-gated** (issue #6): worker in `worker/`
  (OAuth per §1, D1 per §3, examples-only sync, export, transactional
  delete-account per §2), client account UI + sync engine behind a build-time
  flag. Nothing is deployed; the deployed static site is unchanged until the
  runbook below is executed.

### What shipped where

| Piece | Location |
|---|---|
| D1 schema (§3, verbatim) | `worker/migrations/0001_init.sql` |
| OAuth (Google + GitHub, hand-rolled ~50 lines/provider) | `worker/src/providers.ts` — the `OAuthProvider` interface is the test seam; `FAKE_OAUTH=1` (test-only) swaps in a fake |
| Sessions (90-day sliding, HttpOnly/Secure/SameSite=Lax cookie) | `worker/src/sessions.ts` — expiry slides at most ~daily to save D1 writes |
| Sync + export + delete-account | `worker/src/sync.ts`, routed in `worker/src/index.ts` |
| Client feature flag | `web/src/lib/syncConfig.ts` — sync UI exists only when `VITE_SYNC_API_URL` is set at build time |
| Client sync engine (§3 cadence: pull on load, push debounced 10 s) | `web/src/lib/syncEngine.ts` + `syncApi.ts` |
| Account UI (§2 privacy copy verbatim, §5 merge/replace prompt) | `web/src/components/AccountPanel.tsx`, rendered inside the Teach panel |
| Tests | `worker/test/*.spec.ts` (25 integration tests in workerd + local D1 via `@cloudflare/vitest-pool-workers`; `(cd worker && npm test)`), `web/src/lib/{profileFile,syncEngine}.test.ts`, `web/e2e/{profileFile,account}.spec.ts` |

### Implementation decisions (per §8 open questions + details §1–§7 left open)

- **Account linking**: none in v1. The same person via Google and GitHub is
  two accounts (covered by a test). An explicit merge can come later; linking
  silently by email address is a account-takeover-shaped risk we skip.
- **Correction provenance** (`source: 'correction'`): **not stored**. §2
  already defines correction-sourced examples as ordinary `UserExample`s and
  nothing would read the flag today; the file format is versioned, so a later
  `formatVersion` bump can add it if per-source weighting ever materializes.
- **Caps** (§7 risks): 1,000 live example rows per user (push rejected whole
  with `profile full…`, surfaced in the sync status line); 2 MB request body;
  ≤1,000 upserts / ≤2,000 tombstones per push. No Turnstile until abused.
- **Sessions**: 90-day sliding as designed; no "sign out everywhere" in v1
  (deleting the account revokes everything; sessions table supports it later).
- **Old-model-version retention**: the schema keeps per-version rows, but the
  90-day scheduled purge is **not** implemented — at launch scale, stale rows
  are noise. Add a Workers cron when the second model version ships.
- **GDPR**: treat embeddings as personal data; export + real deletion exist
  from day one (§2). No DPA page / EU data-location work in v1.
- **Deletion semantics on the client**: deleting an example (chip ×, undo,
  reset profile) records its uuid in a local tombstone list
  (`localStorage['beatbox-sync-tombstones']`) that is pushed and cleared on
  confirmation — deletes propagate across devices per §3. The §5 *replace*
  migration path clears local rows **without** tombstoning (it discards local
  copies; it must not delete the account profile).
- **Tombstones for never-synced uuids**: deleting a row the server has never
  seen inserts a bare tombstone row (label `''`, empty BLOB) so the deletion
  still beats a live copy pushed later by an offline device.
- **Server export shape**: `GET /api/export` returns the Phase 0 file format;
  the primary `modelVersion`/`examples` are the version with the newest
  activity, and any older versions ride along under an `otherVersions` key
  (unknown top-level keys are ignored by the parser, so the file stays
  importable).
- **Same-origin requirement**: the worker must be routed under `/api/*` on
  the **same origin** as the app. SameSite=Lax cookies and the deliberate
  absence of CORS headers depend on it; a cross-origin deployment would need
  both revisited.
- **Tooling pin**: `worker/package.json` pins `wrangler` 4.85.0 — the last
  line that runs on Node 20 (this repo's toolchain); wrangler ≥4.90 requires
  Node ≥22. `compatibility_date` in `wrangler.toml` must stay ≤ the workerd
  bundled with that pin (currently 2026-04). On a Node ≥22 machine the pin
  can move to latest. Tests are unaffected (vitest-pool-workers bundles its
  own workerd).

### Local development (no Cloudflare account)

```bash
(cd worker && npm install && npm test)          # 25 integration tests, local D1
(cd worker && npx wrangler d1 migrations apply cyborg-drum-machine --local)
(cd worker && npm run dev)                      # http://localhost:8787/api/health
```

OAuth needs real client ids even in dev; for UI work against the fake
provider, run `wrangler dev` with `FAKE_OAUTH=1` in a `.dev.vars` file
(never in production config) and build the web app with
`VITE_SYNC_API_URL=http://localhost:8787/api` behind a dev proxy.

### Go-live runbook (owner, ~30 minutes; keeps issue #6 open until done)

1. **D1**: `(cd worker && npx wrangler d1 create cyborg-drum-machine)` →
   paste the printed `database_id` into `worker/wrangler.toml` →
   `(cd worker && npx wrangler d1 migrations apply cyborg-drum-machine --remote)`.
2. **Google OAuth app** (console.cloud.google.com → Credentials → OAuth client
   ID, type *Web application*): authorized redirect URI
   `https://<app-origin>/api/auth/google/callback`.
3. **GitHub OAuth app** (github.com → Settings → Developer settings): callback
   URL `https://<app-origin>/api/auth/github/callback`.
4. **Secrets**: `(cd worker && npx wrangler secret put GOOGLE_CLIENT_ID)` and
   likewise `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`.
   Set `APP_ORIGIN` in `wrangler.toml` [vars] to the real app origin
   (e.g. `https://cyborg-drum-machine.pages.dev`).
5. **Deploy + route on the app's origin**: `(cd worker && npx wrangler deploy)`,
   then route `/api/*` of the app's domain to the worker (custom domain: a
   Workers route on the zone; pages.dev only: serve app + API from the same
   workers.dev/custom domain — same-origin is a hard requirement, see above).
6. **Rebuild the app with sync on**: set `VITE_SYNC_API_URL=/api` in the CI
   build env (and locally) → deploy Pages as usual. Unset it to kill-switch
   the feature (plan §7 rollback): the UI vanishes, server data stays
   exportable.
7. **Smoke test**: sign in with both providers; teach an example; verify the
   row lands in D1 (`wrangler d1 execute … "SELECT COUNT(*) FROM examples"`),
   pull it on a second browser, export, delete account, confirm 0 rows.
8. Close issue #6.
