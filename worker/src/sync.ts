import { blobToF32, f32ToBlob, type WireExample } from './wire';

/**
 * Examples sync (accounts plan §3): append-only set with tombstoned deletes.
 * Merge = union by uuid; a tombstone beats a live row; no updates-in-place
 * exist. Rows are keyed by model_version, mirroring KnnProfile.load.
 */

/** Per-user cap on live example rows (plan §7 abuse mitigation). */
export const MAX_EXAMPLES_PER_USER = 1000;
/** D1 caps bound parameters per statement; stay well under it. */
const CHUNK = 50;

interface ExampleRow {
  uuid: string;
  label: string;
  embedding: unknown;
  model_probs: unknown;
  created_at: number;
  deleted_at: number | null;
}

export interface PullResult {
  examples: WireExample[];
  tombstones: string[];
}

export async function pullExamples(
  db: D1Database,
  userId: string,
  modelVersion: string,
): Promise<PullResult> {
  const rows = await db
    .prepare(
      `SELECT uuid, label, embedding, model_probs, created_at, deleted_at
       FROM examples WHERE user_id = ? AND model_version = ? ORDER BY created_at`,
    )
    .bind(userId, modelVersion)
    .all<ExampleRow>();
  const examples: WireExample[] = [];
  const tombstones: string[] = [];
  for (const r of rows.results) {
    if (r.deleted_at !== null) {
      tombstones.push(r.uuid);
      continue;
    }
    examples.push(rowToWire(r));
  }
  return { examples, tombstones };
}

export interface PushOutcome {
  ok: boolean;
  error?: string;
  added: number;
  deleted: number;
  /** Live rows for this user (all model versions) after the push. */
  total: number;
}

export async function pushExamples(
  db: D1Database,
  userId: string,
  modelVersion: string,
  upserts: readonly WireExample[],
  deletes: readonly string[],
  now: number,
): Promise<PushOutcome> {
  // Which upsert uuids already exist (any state — tombstones must stay dead,
  // and rows owned by other users must not be touched or counted)?
  const existing = new Set<string>();
  for (let i = 0; i < upserts.length; i += CHUNK) {
    const chunk = upserts.slice(i, i + CHUNK);
    const marks = chunk.map(() => '?').join(',');
    const rows = await db
      .prepare(`SELECT uuid FROM examples WHERE uuid IN (${marks})`)
      .bind(...chunk.map((u) => u.uuid))
      .all<{ uuid: string }>();
    for (const r of rows.results) existing.add(r.uuid);
  }
  const seen = new Set<string>();
  const toInsert = upserts.filter((u) => {
    if (existing.has(u.uuid) || seen.has(u.uuid)) return false;
    seen.add(u.uuid);
    return true;
  });

  const liveCount = await countLive(db, userId);
  if (liveCount + toInsert.length > MAX_EXAMPLES_PER_USER) {
    return {
      ok: false,
      error: `profile full (cap ${MAX_EXAMPLES_PER_USER} examples)`,
      added: 0,
      deleted: 0,
      total: liveCount,
    };
  }

  const stmts: D1PreparedStatement[] = [];
  const insert = db.prepare(
    `INSERT OR IGNORE INTO examples
       (uuid, user_id, model_version, label, embedding, model_probs, created_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
  );
  for (const u of toInsert) {
    stmts.push(
      insert.bind(
        u.uuid,
        userId,
        modelVersion,
        u.label,
        f32ToBlob(u.embedding),
        u.modelProbs ? f32ToBlob(u.modelProbs) : null,
        u.createdAt,
      ),
    );
  }
  // Deletes upsert a tombstone: existing own rows get deleted_at; unknown
  // uuids leave a bare tombstone row (label ''/empty blob) so the deletion
  // wins over a live copy pushed later by an offline device.
  const tombstone = db.prepare(
    `INSERT INTO examples
       (uuid, user_id, model_version, label, embedding, model_probs, created_at, deleted_at)
     VALUES (?, ?, ?, '', X'', NULL, ?, ?)
     ON CONFLICT(uuid) DO UPDATE SET deleted_at = excluded.deleted_at
       WHERE examples.user_id = excluded.user_id AND examples.deleted_at IS NULL`,
  );
  const dedupDeletes = [...new Set(deletes)];
  for (const uuid of dedupDeletes) {
    stmts.push(tombstone.bind(uuid, userId, modelVersion, now, now));
  }
  if (stmts.length > 0) await db.batch(stmts); // atomic

  return {
    ok: true,
    added: toInsert.length,
    deleted: dedupDeletes.length,
    total: await countLive(db, userId),
  };
}

async function countLive(db: D1Database, userId: string): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM examples WHERE user_id = ? AND deleted_at IS NULL')
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Everything the server holds for the user, as a Phase 0 profile file
 * (formatVersion 1). The file format is per-model-version, so the primary
 * `modelVersion`/`examples` carry the version with the most recent activity;
 * any older versions ride along under the extra `otherVersions` key, which
 * the Phase 0 parser ignores (unknown top-level keys are forward-compatible).
 */
export async function exportProfile(db: D1Database, userId: string): Promise<object> {
  const rows = await db
    .prepare(
      `SELECT uuid, model_version, label, embedding, model_probs, created_at, deleted_at
       FROM examples WHERE user_id = ? AND deleted_at IS NULL ORDER BY created_at`,
    )
    .bind(userId)
    .all<ExampleRow & { model_version: string }>();
  const byVersion = new Map<string, WireExample[]>();
  const newest = new Map<string, number>();
  for (const r of rows.results) {
    const list = byVersion.get(r.model_version) ?? [];
    list.push(rowToWire(r));
    byVersion.set(r.model_version, list);
    newest.set(r.model_version, Math.max(newest.get(r.model_version) ?? 0, r.created_at));
  }
  let primary = '';
  for (const [version, t] of newest) {
    if (primary === '' || t > (newest.get(primary) ?? 0)) primary = version;
  }
  const settingsRow = await db
    .prepare('SELECT json FROM settings WHERE user_id = ?')
    .bind(userId)
    .first<{ json: string }>();
  const otherVersions: Record<string, WireExample[]> = {};
  for (const [version, list] of byVersion) {
    if (version !== primary) otherVersions[version] = list;
  }
  return {
    formatVersion: 1,
    modelVersion: primary || 'none',
    examples: primary ? byVersion.get(primary) : [],
    ...(settingsRow ? { settings: JSON.parse(settingsRow.json) as unknown } : {}),
    ...(Object.keys(otherVersions).length > 0 ? { otherVersions } : {}),
  };
}

/**
 * Account deletion (plan §2): a real DELETE of all the user's rows in one
 * atomic batch — tombstones are for sync convergence, not retention.
 */
export async function deleteAccount(db: D1Database, userId: string): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM examples WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM beats WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM settings WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM users WHERE id = ?').bind(userId),
  ]);
}

function rowToWire(r: ExampleRow): WireExample {
  return {
    uuid: r.uuid,
    label: r.label,
    embedding: blobToF32(r.embedding),
    ...(r.model_probs !== null && r.model_probs !== undefined
      ? { modelProbs: blobToF32(r.model_probs) }
      : {}),
    createdAt: r.created_at,
  };
}
