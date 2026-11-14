import pg from 'pg';

const pool = process.env.SPORTSIQ_DATABASE_URL &&
  new pg.Pool({connectionString: process.env.SPORTSIQ_DATABASE_URL, max: 2, connectionTimeoutMillis: 5000});
const apiKey = process.env.FIREBASE_API_KEY;
const projectId = process.env.FIREBASE_PROJECT_ID;
const leagues = {
  'Basketball/pro': 'basketball/nba', 'Football/pro': 'football/nfl',
  'Basketball/college': 'basketball/mens-college-basketball',
  'Football/college': 'football/college-football'
};
let schema;
function initialize() {
  return schema ??= pool.query(`
    CREATE TABLE IF NOT EXISTS sportsiq.practice_wallets (
      uid text PRIMARY KEY, cents integer NOT NULL CHECK (cents >= 0)
    );
    CREATE TABLE IF NOT EXISTS sportsiq.practice_bets (
      uid text REFERENCES sportsiq.practice_wallets(uid), request_id uuid,
      sport text NOT NULL, level text NOT NULL, day text NOT NULL,
      event_id text NOT NULL, team text NOT NULL, side text NOT NULL,
      cents integer NOT NULL, odds integer NOT NULL, book text NOT NULL,
      captured_at timestamptz NOT NULL, result text,
      created_at timestamptz DEFAULT now(), PRIMARY KEY(uid, request_id)
    );
  `).catch(error => { schema = undefined; throw error; });
}
function failure(status, message) { return Object.assign(new Error(message), {status}); }
async function user(req) {
  const token = req.headers.authorization?.match(/^Bearer (\S+)$/i)?.[1];
  if (!token) throw failure(401, 'Sign in to use practice bets.');
  const response = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' +
    encodeURIComponent(apiKey), {method:'POST', headers:{'Content-Type':'application/json'},
    body:JSON.stringify({idToken:token}), signal:AbortSignal.timeout(8000)});
  if (response.status >= 500) throw failure(503, 'Sign-in temporarily unavailable.');
  const account = response.ok && (await response.json()).users?.[0];
  if (!account?.localId || account.disabled) throw failure(401, 'Sign in again.');
  return account.localId;
}
async function transaction(uid, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO sportsiq.practice_wallets VALUES ($1,100000) ON CONFLICT DO NOTHING',[uid]);
    await client.query('SELECT uid FROM sportsiq.practice_wallets WHERE uid=$1 FOR UPDATE',[uid]);
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
async function settle(uid, games) {
  const {rows} = await pool.query('SELECT * FROM sportsiq.practice_bets WHERE uid=$1 AND result IS NULL',[uid]);
  const slates = new Map();
  const outcomes = [];
  for (const bet of rows) {
    const key = [bet.sport,bet.level,bet.day].join('/');
    if (!slates.has(key)) slates.set(key, games(bet.sport,bet.day,bet.level).catch(() => null));
    const game = (await slates.get(key))?.games.find(item => String(item.id) === bet.event_id);
    if (!game) continue;
    const score = /^([0-9]+) – ([0-9]+)$/.exec(game.score);
    let result;
    if (/^cancel(?:led|ed)$/i.test(game.status)) result = 'Void';
    else if (/^final/i.test(game.status) && score) {
      const away = Number(score[1]), home = Number(score[2]);
      result = home === away ? 'Void' : (home > away ? 'home' : 'away') === bet.side ? 'Won' : 'Lost';
    } else continue;
    outcomes.push({bet,result});
  }
  return transaction(uid, async client => {
    for (const {bet,result} of outcomes) {
      const update = await client.query('UPDATE sportsiq.practice_bets SET result=$3 WHERE uid=$1 AND request_id=$2 AND result IS NULL',
        [uid,bet.request_id,result]);
      if (!update.rowCount) continue;
      const profit = Math.floor(bet.cents * (bet.odds > 0 ? bet.odds / 100 : 100 / -bet.odds));
      const payout = result === 'Lost' ? 0 : bet.cents + (result === 'Won' ? profit : 0);
      await client.query('UPDATE sportsiq.practice_wallets SET cents=cents+$2 WHERE uid=$1',[uid,payout]);
    }
    const wallet = await client.query('SELECT cents FROM sportsiq.practice_wallets WHERE uid=$1',[uid]);
    const history = await client.query('SELECT team,cents,odds,book,result FROM sportsiq.practice_bets WHERE uid=$1 ORDER BY created_at DESC LIMIT 100',[uid]);
    return {cents:wallet.rows[0].cents,bets:history.rows};
  });
}
async function body(req) {
  let value = '';
  for await (const chunk of req) {
    value += chunk;
    if (value.length > 4096) throw failure(413,'Bet request too large.');
  }
  try { return JSON.parse(value) ?? {}; }
  catch { throw failure(400,'Invalid bet request.'); }
}
async function place(req, uid, games) {
  const {sport,level,day,id,side,cents,requestId,book,at,odds} = await body(req);
  const league = leagues[sport+'/'+level];
  if (!league || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^\d{1,12}$/.test(id) ||
      !['home','away'].includes(side) || !Number.isSafeInteger(cents) || cents<100 || cents>100000 ||
      !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(requestId))
    throw failure(400,'Choose a team and enter a stake from $1 to $1,000.');
  const existing = await pool.query('SELECT request_id FROM sportsiq.practice_bets WHERE uid=$1 AND request_id=$2',[uid,requestId]);
  if (existing.rowCount) return;
  const game = (await games(sport,day,level)).games.find(item => String(item.id)===id);
  if (!game || game.status !== 'Scheduled' || game.score || !(Date.parse(game.date)>Date.now())) throw failure(409,'Pregame betting has closed.');
  const quotes = await fetch('https://raw.githubusercontent.com/I4CWLTH/SportsIQ-AI/main/lines.json',
    {signal:AbortSignal.timeout(8000)});
  if (!quotes.ok) throw failure(503,'Saved sportsbook quotes unavailable.');
  const rows = (await quotes.json())[league+'/'+id] || [];
  const quote = rows.filter(row=>row.book===book).sort((a,b)=>b.at.localeCompare(a.at))[0];
  const price = Number(quote?.[side]);
  if (!quote || quote.at!==at || price!==odds || !Number.isSafeInteger(price) ||
      Math.abs(price)<100 || Math.abs(price)>100000 || !(Date.parse(at)>Date.now()-86400000))
    throw failure(409,'That quote changed or expired. Reopen the matchup to refresh.');
  await transaction(uid, async client => {
    const duplicate = await client.query('SELECT request_id FROM sportsiq.practice_bets WHERE uid=$1 AND request_id=$2',[uid,requestId]);
    if (duplicate.rowCount) return;
    if (Date.parse(game.date)<=Date.now()) throw failure(409,'Pregame betting has closed.');
    const debit = await client.query('UPDATE sportsiq.practice_wallets SET cents=cents-$2 WHERE uid=$1 AND cents >= $2',[uid,cents]);
    if (!debit.rowCount) throw failure(409,'Your virtual balance is too low.');
    await client.query(`INSERT INTO sportsiq.practice_bets
      (uid,request_id,sport,level,day,event_id,team,side,cents,odds,book,captured_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [uid,requestId,sport,level,day,id,game[side].name,side,cents,price,book,at]);
  });
}
export async function practice(req, path, send, games) {
  if (!pool || !apiKey || !projectId) return send(503,{error:'Practice bets are awaiting account and database setup.'});
  if (path === '/api/practice/config') {
    try { await initialize(); }
    catch { return send(503,{error:'Practice betting database is temporarily unavailable.'}); }
    return send(200,{apiKey,projectId,authDomain:process.env.FIREBASE_AUTH_DOMAIN});
  }
  if (path !== '/api/practice/bets' || !['GET','POST'].includes(req.method))
    return send(404,{error:'Unknown practice bet operation.'});
  try {
    const uid = await user(req);
    await initialize();
    if (req.method === 'POST') await place(req,uid,games);
    return send(200,await settle(uid,games));
  } catch (error) {
    if (!error.status) console.error('Practice betting request failed',error.code || error.name);
    return send(error.status || 503,{error:error.status ? error.message : 'Practice betting temporarily unavailable.'});
  }
}
