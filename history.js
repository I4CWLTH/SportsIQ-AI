import pg from 'pg';

const pool = process.env.SPORTSIQ_DATABASE_URL
  ? new pg.Pool({ connectionString: process.env.SPORTSIQ_DATABASE_URL, max: 2, connectionTimeoutMillis: 5000 })
  : null;
pool?.on('error', () => console.error('Sports IQ history database connection interrupted'));

const ready = pool && (async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query('CREATE SCHEMA IF NOT EXISTS sportsiq');
    await client.query(`CREATE TABLE IF NOT EXISTS sportsiq.predictions (
      league text NOT NULL,
      event_id text NOT NULL,
      pick text NOT NULL CHECK (pick IN ('home', 'away')),
      confidence integer NOT NULL,
      model_version text NOT NULL,
      scheduled_at timestamptz NOT NULL,
      recorded_at timestamptz NOT NULL DEFAULT now(),
      final_home integer,
      final_away integer,
      final_at timestamptz,
      PRIMARY KEY (league, event_id)
    )`);
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
})().catch(() => {
  console.error('Sports IQ history initialization failed');
  return false;
});

export async function recordHistory(league, games) {
  if (!await ready || !games.length) return;
  const snapshots = games.map(game => ({
    id: game.id, scheduled_at: game.date,
    pick: game.probability === null ? null : Math.round(game.probability * 100) >= 50 ? 'home' : 'away',
    confidence: game.probability === null ? null : Math.max(Math.round(game.probability * 100), 100 - Math.round(game.probability * 100)),
    home: game.final?.home, away: game.final?.away
  }));
  const payload = JSON.stringify(snapshots);
  await pool.query(`
    INSERT INTO sportsiq.predictions (league, event_id, pick, confidence, model_version, scheduled_at)
    SELECT $1, id, pick, confidence, 'record-v1', scheduled_at
    FROM jsonb_to_recordset($2::jsonb) AS event(id text, pick text, confidence int, scheduled_at timestamptz)
    WHERE pick IS NOT NULL AND scheduled_at > now()
    ON CONFLICT DO NOTHING`, [league, payload]);
  await pool.query(`
    UPDATE sportsiq.predictions AS prediction
    SET final_home = event.home, final_away = event.away, final_at = now()
    FROM jsonb_to_recordset($2::jsonb) AS event(id text, home int, away int)
    WHERE prediction.league = $1 AND prediction.event_id = event.id
      AND event.home IS NOT NULL AND event.away IS NOT NULL
      AND (prediction.final_home, prediction.final_away) IS DISTINCT FROM (event.home, event.away)`, [league, payload]);
  const { rows } = await pool.query(`
    SELECT event_id, pick, confidence, final_home, final_away
    FROM sportsiq.predictions WHERE league = $1 AND event_id = ANY($2::text[])`,
    [league, games.map(game => game.id)]);
  const byId = new Map(rows.map(row => [row.event_id, row]));
  for (const game of games) {
    const saved = byId.get(game.id);
    if (!saved) continue;
    game.probability = saved.pick === 'home' ? saved.confidence / 100 : (100 - saved.confidence) / 100;
    game.savedPrediction = { pick: saved.pick, confidence: saved.confidence };
  }
}

export const historyEnabled = Boolean(pool);
