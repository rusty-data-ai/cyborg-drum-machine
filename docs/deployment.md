# Deployment

Plan and runbook for hosting the app. Everything that needs no credentials is
already committed (hosting config, CI, caching headers, URL beat-sharing); the
owner-side account steps are in the [runbook](#deploy-runbook) at the bottom.

**TL;DR: Cloudflare Pages, deployed from GitHub Actions with wrangler.** The
app is a single-route static SPA (~15 MB raw, ~5.5 MB compressed first visit)
whose "ML hosting" story is just static files with good cache headers —
inference runs client-side in WASM (~2.3 ms/hit) and user data stays in
IndexedDB. No server exists, and none is needed to launch.

## What gets deployed

`(cd web && npm run build)` → `web/dist/`:

| Asset | Size (gzip) | URL stability |
|---|---|---|
| ort WASM runtime | 13.5 MB (3.5 MB) | content-hashed under `/assets/` |
| JS + CSS bundles | ~300 KB (~95 KB) | content-hashed under `/assets/` |
| `models/beatbox.onnx` | 1.5 MB | unhashed — versioned by convention, see below |
| `models/beatbox.json` | <1 KB | unhashed manifest, always revalidated |
| `drums/*.wav`, `onset-processor.js`, `index.html` | ~200 KB | unhashed |

Requirements: HTTPS (getUserMedia), sane MIME for `.wasm`/`.onnx`, custom
cache headers. **No** COOP/COEP (single-threaded WASM, no SharedArrayBuffer),
no server routes (single route; shared beats travel in the URL *fragment*).
Training data (~600 MB) never deploys.

## Provider comparison (free tiers, verified July 2026)

| | Cloudflare Pages | Netlify Free | Vercel Hobby | GitHub Pages |
|---|---|---|---|---|
| Bandwidth | **Unlimited** | ~15 GB/mo (300 credits, 20 credits/GB) | 100 GB/mo | 100 GB/mo (soft) |
| Builds / deploys | 500 builds/mo (we build in CI, so effectively unlimited) | ~20 production deploys/mo (15 credits each) | 100 build-min/mo | 10 builds/hr (soft; N/A with Actions) |
| Custom domain + TLS | ✓ (100/project) | ✓ | ✓ | ✓ (one per site) |
| Custom headers | ✓ `_headers` | ✓ `_headers` | ✓ `vercel.json` | **✗ — none** |
| Commercial use | ✓ | ✓ | **✗ (non-commercial only)** | ✓ (no commercial *sites* per ToS) |
| Max file size | 25 MiB | — | — | 100 MB file / 1 GB site |
| Other notes | headers comma-join on overlapping rules (our `_headers` avoids overlaps) | credit model repriced Apr 2026; bandwidth credits halved | 30-day lockout on overage | `Cache-Control: max-age=600` fixed |

Sources: [Cloudflare Pages limits](https://developers.cloudflare.com/pages/platform/limits/),
[Netlify pricing](https://www.netlify.com/pricing/) ([2026 credit analysis](https://netli.fyi/blog/netlify-pricing-and-limits)),
[Vercel Hobby plan](https://vercel.com/docs/plans/hobby) / [limits](https://vercel.com/docs/limits),
[GitHub Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits),
[GH Pages header discussion](https://github.com/orgs/community/discussions/54257),
[Pages `_headers` docs](https://developers.cloudflare.com/pages/configuration/headers/).

### Recommendation: Cloudflare Pages

- **Bandwidth is our only meaningful axis and it's unlimited.** First-visit
  payload is ~5.5 MB compressed; a modest 1k users/mo with revisits is
  ~10–20 GB/mo — already *over* Netlify's new free tier (~15 GB) and a third
  of a bad month would dent Vercel's 100 GB.
- **Header control is required to do this well.** GitHub Pages cannot set
  headers at all: everything (including the 13.5 MB WASM) is served with
  `max-age=600`, so repeat visitors revalidate or re-download the heaviest
  assets, and the immutable-model versioning below is impossible. It would
  *work* (MIME for `.wasm` is correct, HTTPS is on), but it wastes exactly the
  bandwidth we care about. Fine as a zero-config mirror, wrong as the primary.
- **Vercel's Hobby tier prohibits commercial use** — a landmine if this ever
  earns a cent — and its 100 GB cap ends in a 30-day feature lockout.
- Deploys are a one-command `wrangler pages deploy` of our CI-built `dist/`,
  so Cloudflare's 500-builds/mo limit isn't even consumed.

Caveat to watch: Pages caps single files at 25 MiB. The ort WASM is 13.5 MB
and the model 1.5 MB; a future model >25 MiB would need Cloudflare R2 (or a
smaller quantization — preferable anyway for mobile load time).

Config committed: `web/wrangler.toml` (project name + output dir) and
`web/public/_headers` (Vite copies it into `dist/`). SPA fallback needs no
config: the app has one route, and with no `404.html` present Pages serves
`index.html` for stray paths anyway. The `_headers` format is
Netlify-compatible, so falling back to Netlify keeps the same caching.

## Caching & versioning

Implemented in `web/public/_headers`. Rules are deliberately non-overlapping
because Cloudflare comma-joins duplicate headers from multiple matching rules.

| Path | Cache-Control | Why |
|---|---|---|
| `/assets/*` | `public, max-age=31536000, immutable` | Vite content-hashes JS/CSS/WASM — a new build is a new URL |
| `/models/*.onnx` | `public, max-age=31536000, immutable` | versioned **by filename convention** (below) |
| `/models/beatbox.json` | `public, no-cache` | tiny manifest; revalidate every load so model changes propagate immediately |
| `/drums/*` | `public, max-age=604800` | unhashed, change ~never; cheap ETag 304 after a week |
| `/onset-processor.js` | `public, no-cache` | unhashed worklet that changes with app code |
| `/`, `/index.html` | `public, no-cache` | entry point must always pick up new hashed bundles |

### Model URL versioning (wired)

Chosen scheme: **versioned filename referenced from the manifest**, rather
than hashing the model into `/assets/` (the model is produced by `ml/export.py`,
not by Vite, and its lifecycle — retraining — is independent of app builds).

- `ModelMeta` now has an optional `file` field; `classifier.ts` loads
  `` `${baseUrl}/${meta.file ?? 'beatbox.onnx'}` ``. The always-revalidated
  `beatbox.json` is therefore the single source of truth for *which* model
  binary to fetch, and `.onnx` files can be cached as immutable.
- **Rule: never overwrite a deployed `.onnx` in place.** On the next retrain,
  export to `models/beatbox-v3.onnx` and set `"file": "beatbox-v3.onnx"` (and
  the bumped `"version"`) in `beatbox.json`. The version bump already
  invalidates stored KNN profiles, exactly as before. `ml/export.py` should be
  updated then to emit the suffixed filename + `file` field (left untouched
  now; the current `beatbox.onnx` deploys fine as-is because the manifest and
  binary ship together on first deploy).
- Old model files can be deleted a few days after a release; `no-cache` on the
  manifest means clients switch on their next page load.

## Beat sharing

### v1 — in the URL, zero backend (implemented)

A `Pattern` is small (6 drums × ≤64 steps × velocity + bpm), so the whole beat
fits in the link itself. This is the right v1: no accounts, no storage, no
abuse surface, no cost, works on any static host, and the fragment never even
reaches a server (it also can't leak into server logs). The only real
downsides — long-ish URLs (~90–260 chars) and links that can't be revoked or
counted — don't matter at this stage.

Implemented in `web/src/lib/share.ts` (+ unit tests, + an e2e round-trip):

- **Encoding**: versioned binary → base64url. Header: version byte,
  bpm×2 (uint16), step count, drum-row count; then 4-bit velocities packed two
  per byte, rows in `DRUM_CLASSES` order. Worst case 197 bytes → ~263 chars.
- **Forward compatibility**: decoders ignore extra drum rows (new pads don't
  need a version bump); any semantic change bumps the version byte and
  `decodePattern` returns `null` for unknown versions. Decoding is strict —
  bad charset, wrong length, or out-of-range fields all reject rather than
  produce a half-garbage pattern.
- **UI**: a *share* button (next to *clear*) copies
  `https://…/#p=<payload>` and also writes it to the URL bar via
  `replaceState` (covers blocked clipboards); on boot the app hydrates the
  grid from `location.hash`.

### v2 — short links via Workers + KV (designed, not built)

When URLs should be short/pretty (`https://…/b/x7Kq3F9a`), add a Cloudflare
Worker in front of the same Pages project. Design:

- **API**:
  - `POST /api/beats` body `{"p": "<v1 fragment payload>"}` →
    `201 {"id": "x7Kq3F9a", "url": "https://…/b/x7Kq3F9a"}`
  - `GET /b/:id` → `302 Location: /#p=<payload>` — the client stays 100%
    unchanged; the Worker only translates id → fragment.
- **Data model**: KV `beat:<id>` → the base64url payload string (≤ ~300 B),
  metadata `{createdAt}`. `id` = 8 chars from 48 random bits (collision-checked
  on write). KV fits: write-rarely/read-often, no queries needed.
- **Validation & abuse limits**: request body capped at 1 KB; the Worker
  *decodes* the payload with the same versioned codec and rejects anything
  `decodePattern` would reject (it's plain TS — reusable in the Worker);
  per-IP rate limit (Workers rate-limiting binding, e.g. 10 creates/min);
  no enumeration/list endpoint; optional Turnstile if abused anyway.
- **Capacity/cost on free tier**: 100k Worker req/day, 100k KV reads/day,
  1k KV writes/day → 1,000 new shared beats and 100k opens per day at $0.
  Overflow → Workers Paid, $5/mo.
- Client change when it lands: share button does the POST and falls back to
  the fragment URL if it fails. The fragment format stays the canonical wire
  format either way.

## Data storage: what could ever live server-side

| Data | Server-side? | Notes |
|---|---|---|
| Shared beat patterns | **Yes** — first backend feature | not personal, tiny, explicit user action (design above) |
| Raw audio (mic recordings, calibration takes) | **Never** | product promise, in the footer: "all audio stays in your browser" |
| Calibration profiles (label + 128-d embedding + modelVersion) | **Opt-in only, later** | embeddings are derived features, not audio — but a "sync profile" toggle must be explicit, additive, and off by default; footer copy stays true |
| Tuning settings (localStorage) | Piggyback on profile sync | trivial |

**Cross-device profile sync**: designed in `docs/accounts-plan.md` (OAuth +
Workers + D1, opt-in, embeddings-only) and now **code-complete in `worker/`
but deploy-gated on owner credentials** — see accounts-plan §9 for the
go-live runbook. Until that runbook runs, nothing here deploys and the static
site is unchanged (the sync UI only exists when `VITE_SYNC_API_URL` is set at
build time). Profile backup/transfer already works with zero backend via the
Teach panel's export/import file (accounts plan Phase 0).

**Server-side inference (optional later phase, designed only)**: today's
model is 1.5 MB / 2.3 ms in-browser, so an inference API has negative value.
It becomes interesting only if (a) a much heavier model meaningfully beats the
current one, or (b) low-end mobile can't run WASM fast enough. Shape then: keep
the on-device model as the default/offline path; add `POST /api/classify`
(250 ms PCM, opt-in, explicit UI consent since it uploads audio — this *changes
the product promise* and must be a loud, separate toggle) backed by Workers AI
or a small GPU container behind a queue. Nothing in the current architecture
blocks this; nothing in it needs this.

## Cost at small scale (<1k users)

| Item | Provider | Free tier covers | Monthly cost |
|---|---|---|---|
| Static hosting + CDN | Cloudflare Pages | unlimited bandwidth, 500 builds | $0 |
| CI | GitHub Actions | 2,000 min/mo (public repo: unlimited) | $0 |
| Short-link backend (v2, optional) | Workers + KV | 100k req/day, 1k writes/day | $0 |
| Custom domain (optional) | any registrar | — | ~$10/yr |
| **Total** | | | **$0 + optional domain** |

**First paid bottleneck**: nothing at this scale on the static path —
Cloudflare Pages has no bandwidth meter to run over. The first realistic
invoice is **Workers Paid ($5/mo)** if the v2 share backend ever exceeds 100k
requests or 1k new beats per day. (Had we picked Netlify, the first bottleneck
would instead be bandwidth at roughly 2–3k first visits/mo — that asymmetry is
most of the recommendation.) The next one after that: a model >25 MiB forcing
assets onto R2 (free to 10 GB storage; egress is free to Cloudflare's CDN).

## CI (implemented)

`.github/workflows/ci.yml`, on every push to `main` and every PR:

1. `npm ci` (npm cache via setup-node) → unit tests → Playwright chromium
   (browser binaries cached on the lockfile hash) → `npm run build` →
   `dist/` uploaded as an artifact (14-day retention).
2. `deploy` job (pushes to `main` only): downloads the built artifact and runs
   `npx wrangler@4 pages deploy`. Every step is guarded on
   `CLOUDFLARE_API_TOKEN` being non-empty, so **the job is a no-op until the
   secrets below exist** — CI stays green with zero configuration.

Secret names: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.

## Deploy runbook

One-time (owner, ~15 minutes):

1. Create a free Cloudflare account.
2. Locally: `(cd web && npx wrangler login && npx wrangler pages project create cyborg-drum-machine --production-branch=main)`
   (project name must match `name` in `web/wrangler.toml`).
3. First deploy + smoke test: `(cd web && npm run build && npx wrangler pages deploy)`
   → visit the printed `https://cyborg-drum-machine.pages.dev`, allow the mic,
   record a beat, check DevTools → Network that `/assets/*.wasm` and
   `beatbox.onnx` return the immutable Cache-Control from `_headers`.
4. Wire up CI deploys (GitHub repo → Settings → Secrets and variables → Actions):
   - `CLOUDFLARE_API_TOKEN`: Cloudflare dashboard → My Profile → API Tokens →
     Create Token → *"Cloudflare Pages — Edit"* template, scoped to this account.
   - `CLOUDFLARE_ACCOUNT_ID`: dashboard sidebar (or `npx wrangler whoami`).
5. Optional: Pages project → *Custom domains* → add the domain (DNS is
   automatic if the domain is on Cloudflare, CNAME otherwise).
6. License check (already satisfied, verify it stays): the deployed footer
   credits AVP/AVP-LVT (CC BY 4.0) — required by the model's training-data
   license. beatboxset1 audio is not shipped.

Recurring:

- **Normal path: `git push` to `main`** — CI tests, builds, and deploys.
- Manual escape hatch: `(cd web && npm run build && npx wrangler pages deploy)`.
- On model retrain: new `beatbox-vN.onnx` + updated `beatbox.json` (see
  [model versioning](#model-url-versioning-wired)) — never overwrite an
  existing `.onnx` filename.
