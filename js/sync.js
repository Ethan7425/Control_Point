// Syncs local run history (IndexedDB, always the source of truth) with the
// `runs` table in Supabase, when signed in. Sync is best-effort and additive:
// a failed push/pull never blocks or corrupts the local copy — this app has to
// keep working exactly as before for anyone not using an account at all.

import { supabase } from './supabase-client.js';
import { saveRun, getAllRuns } from './db.js';

function runToRow(run, userId) {
  return {
    id: run.id,
    user_id: userId,
    mode: run.mode,
    started_at: run.startedAt,
    ended_at: run.endedAt,
    total_ms: run.totalMs,
    distance_m: run.distanceM,
    elevation_gain_m: run.elevationGainM ?? null,
    elevation_loss_m: run.elevationLossM ?? null,
    points_total: run.pointsTotal,
    points_collected: run.pointsCollected,
    score: run.score,
    settings: run.settings,
    points: run.points,
    route: run.route,
    loop_geometry: run.loopGeometry ?? null,
  };
}

function rowToRun(row) {
  return {
    id: row.id,
    mode: row.mode,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    totalMs: row.total_ms,
    distanceM: row.distance_m,
    elevationGainM: row.elevation_gain_m ?? undefined,
    elevationLossM: row.elevation_loss_m ?? undefined,
    pointsTotal: row.points_total,
    pointsCollected: row.points_collected,
    score: row.score,
    settings: row.settings,
    points: row.points,
    route: row.route,
    loopGeometry: row.loop_geometry ?? null,
  };
}

// Pushes one finished run up. Silent no-op if not signed in or offline — the
// local save already happened, so this is purely "also try to sync it".
export async function pushRun(run, userId) {
  if (!supabase || !userId) return;
  try {
    const { error } = await supabase.from('runs').upsert(runToRow(run, userId));
    if (error) console.warn('Sync: failed to push run', run.id, error.message);
  } catch (e) {
    console.warn('Sync: push failed (likely offline):', e.message);
  }
}

export async function deleteRemoteRun(id, userId) {
  if (!supabase || !userId) return;
  try {
    const { error } = await supabase.from('runs').delete().eq('id', id);
    if (error) console.warn('Sync: failed to delete remote run', id, error.message);
  } catch (e) {
    console.warn('Sync: delete failed (likely offline):', e.message);
  }
}

// Pulls every remote run for this user and merges into local IndexedDB. Local
// run ids and remote ids share the same format, so saveRun()'s upsert-by-id
// naturally dedupes — this never overwrites a local run with older data,
// since both sides hold the same finished snapshot for a given id.
export async function pullAndMergeRuns(userId) {
  if (!supabase || !userId) return { pulled: 0, error: null };
  try {
    const { data, error } = await supabase.from('runs').select('*').eq('user_id', userId);
    if (error) return { pulled: 0, error };
    for (const row of data) {
      await saveRun(rowToRun(row));
    }
    return { pulled: data.length, error: null };
  } catch (e) {
    return { pulled: 0, error: e };
  }
}

// Pushes every local run not already known to exist remotely — used once right
// after a fresh sign-up/sign-in, so history recorded before creating an account
// doesn't get left behind on just this one device.
export async function pushAllLocalRuns(userId) {
  if (!supabase || !userId) return;
  const localRuns = await getAllRuns();
  for (const run of localRuns) {
    await pushRun(run, userId);
  }
}
