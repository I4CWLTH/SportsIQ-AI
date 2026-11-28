import {randomUUID} from 'node:crypto';
import {initializeApp} from 'firebase-admin/app';
import {getAuth} from 'firebase-admin/auth';
import pg from 'pg';

const {DATABASE_URL, PUBLIC_ORIGIN, FIREBASE_PROJECT_ID, FIREBASE_API_KEY, FIREBASE_APP_ID, FIREBASE_AUTH_DOMAIN} = process.env;
const ready = Boolean(DATABASE_URL && PUBLIC_ORIGIN && FIREBASE_PROJECT_ID && FIREBASE_API_KEY && FIREBASE_APP_ID);
const pool = ready ? new pg.Pool({connectionString: DATABASE_URL, max: 5}) : null;
const auth = ready ? getAuth(initializeApp({projectId: FIREBASE_PROJECT_ID})) : null;
let schema;
const initialize = () => schema ??= pool.query(`
CREATE TABLE IF NOT EXISTS practice_accounts (
  id uuid PRIMARY KEY, email text UNIQUE NOT NULL, imported boolean NOT NULL DEFAULT false
);
ALTER TABLE practice_accounts ADD COLUMN IF NOT EXISTS firebase_uid text;
CREATE UNIQUE INDEX IF NOT EXISTS practice_account_firebase_uid ON practice_accounts(firebase_uid);
CREATE TABLE IF NOT EXISTS practice_tickets (
  account_id uuid NOT NULL REFERENCES practice_accounts(id), id uuid NOT NULL,
  data jsonb NOT NULL, PRIMARY KEY(account_id,id)
);`).catch(error => {schema=undefined;throw error});

async function body(req){
  let input='';
  for await(const chunk of req){
    input+=chunk;
    if(input.length>65536)throw new Error('Request too large');
  }
  return JSON.parse(input||'{}');
}
async function transaction(action){
  const db=await pool.connect();
  try{
    await db.query('BEGIN');
    const result=await action(db);
    await db.query('COMMIT');
    return result;
  }catch(error){
    await db.query('ROLLBACK');
    throw error;
  }finally{db.release()}
}
async function tickets(db,id){
  const result=await db.query('SELECT data FROM practice_tickets WHERE account_id=$1 ORDER BY data->>\'placedAt\' DESC',[id]);
  return result.rows.map(row=>row.data);
}
function balance(rows){
  return 10000+rows.reduce((amount,bet)=>amount+(bet.imported||bet.canceledAt||bet.result==='push'?0:bet.result==='win'?bet.units:-bet.units),0);
}
async function grade(rows,loadGames,account){
  const slates=new Map();
  await Promise.all(rows.filter(bet=>!bet.result&&!bet.imported&&!bet.canceledAt).map(async bet=>{
    const key=[bet.sport,bet.date,bet.level].join('|');
    if(!slates.has(key))slates.set(key,loadGames(bet.sport,bet.date,bet.level).catch(()=>({games:[]})));
    const game=(await slates.get(key)).games.find(entry=>String(entry.id)===bet.gameId);
    if(!game||!/^final/i.test(game.status))return;
    const parts=game.score.split(/\s*–\s*/);
    if(parts.length!==2||parts.some(part=>!/^\d+$/.test(part)))return;
    const [away,home]=parts.map(Number);
    const result=away===home?'push':bet.side===(home>away?'home':'away')?'win':'loss';
    await pool.query(`UPDATE practice_tickets SET data=data||$3::jsonb
      WHERE account_id=$1 AND id=$2 AND NOT data ? 'canceledAt'`,
    [account,bet.ticketId,JSON.stringify({result,finalScore:game.score})]);
  }));
}
export async function practiceAccounts(req,res,url,send,loadGames){
  if(!url.pathname.startsWith('/api/practice/'))return false;
  if(!ready){send(503,{error:'Practice accounts are being set up.'});return true}
  const route=url.pathname.slice('/api/practice/'.length);
  res.setHeader('Referrer-Policy','no-referrer');
  try{
    if(route==='config'&&req.method==='GET'){
      send(200,{
        projectId:FIREBASE_PROJECT_ID,apiKey:FIREBASE_API_KEY,appId:FIREBASE_APP_ID,
        authDomain:FIREBASE_AUTH_DOMAIN||FIREBASE_PROJECT_ID+'.firebaseapp.com'
      });return true;
    }
    if(req.method==='POST'&&req.headers.origin!==PUBLIC_ORIGIN){
      send(403,{error:'Invalid request origin.'});return true;
    }
    const bearer=req.headers.authorization?.match(/^Bearer ([^ ]+)$/);
    let identity;
    if(bearer){
      try{identity=await auth.verifyIdToken(bearer[1])}catch{}
    }
    if(!identity){send(401,{error:'Sign in to save practice bets.'});return true}
    if(!identity.email_verified||typeof identity.email!=='string'){
      send(403,{error:'Verify your email before using Practice Bets.'});return true;
    }
    await initialize();
    const email=identity.email.trim().toLowerCase();
    const existing=await pool.query('SELECT id,email,imported FROM practice_accounts WHERE firebase_uid=$1',[identity.uid]);
    const user=existing.rows[0]||(await pool.query(`
      INSERT INTO practice_accounts(id,email,firebase_uid) VALUES($1,$2,$3)
      ON CONFLICT(email) DO UPDATE SET firebase_uid=excluded.firebase_uid
      WHERE practice_accounts.firebase_uid IS NULL OR practice_accounts.firebase_uid=excluded.firebase_uid
      RETURNING id,email,imported`,[randomUUID(),email,identity.uid])).rows[0];
    if(!user){send(409,{error:'This practice account is already linked to another sign-in.'});return true}
    if(route==='ledger'&&req.method==='GET'){
      await grade(await tickets(pool,user.id),loadGames,user.id);
      const rows=await tickets(pool,user.id);
      send(200,{email:user.email,imported:user.imported,tickets:rows,balance:balance(rows)});return true;
    }
    if(req.method==='POST'&&['place','cancel','import'].includes(route)){
      const input=await body(req);
      let game;
      if(route==='place'){
        if(!['home','away'].includes(input.side)||!Number.isInteger(input.units)||input.units<1||input.units>1000||
          !/^\d{4}-\d{2}-\d{2}$/.test(input.date)||!/^\d{1,12}$/.test(input.gameId)||
          !['pro','college'].includes(input.level)||!['Basketball','Football','Baseball','Soccer','Hockey'].includes(input.sport)||
          !/^[0-9a-f-]{36}$/i.test(input.ticketId)){send(400,{error:'Invalid practice ticket.'});return true}
        game=(await loadGames(input.sport,input.date,input.level)).games.find(g=>String(g.id)===input.gameId);
        await grade(await tickets(pool,user.id),loadGames,user.id);
      }
      const error=await transaction(async db=>{
        const lock=await db.query('SELECT imported FROM practice_accounts WHERE id=$1 FOR UPDATE',[user.id]);
        if(route==='place'){
          const rows=await tickets(db,user.id);
          if(rows.some(row=>row.ticketId===input.ticketId))return null;
          if(!game||game.state!=='pre'||!(Date.parse(game.date)>Date.now()))return 'This matchup is closed.';
          if(balance(rows)<input.units)return 'Insufficient practice balance.';
          const data={ticketId:input.ticketId,gameId:input.gameId,sport:input.sport,level:input.level,date:input.date,
            side:input.side,units:input.units,pick:game[input.side].name,matchup:game.away.name+' vs '+game.home.name,
            kickoff:game.date,placedAt:new Date().toISOString()};
          await db.query('INSERT INTO practice_tickets VALUES($1,$2,$3)',[user.id,data.ticketId,data]);
        }else if(route==='cancel'){
          if(typeof input.ticketId!=='string'||!/^[0-9a-f-]{36}$/i.test(input.ticketId))return 'Invalid practice ticket.';
          const selected=await db.query('SELECT data FROM practice_tickets WHERE account_id=$1 AND id=$2 FOR UPDATE',[user.id,input.ticketId]);
          if(!selected.rowCount)return 'Practice ticket not found.';
          const ticket=selected.rows[0].data;
          if(ticket.imported||ticket.result||ticket.canceledAt)return 'This ticket cannot be canceled.';
          if(!ticket.kickoff||!Number.isFinite(Date.parse(ticket.kickoff))||Date.parse(ticket.kickoff)<=Date.now())
            return 'The game has started or the ticket cannot be safely verified.';
          await db.query(`UPDATE practice_tickets SET data=data||$3::jsonb WHERE account_id=$1 AND id=$2`,
            [user.id,input.ticketId,JSON.stringify({canceledAt:new Date().toISOString()})]);
        }else{
          if(lock.rows[0].imported)return 'This account already imported browser history.';
          if(!Array.isArray(input.tickets)||!input.tickets.length||input.tickets.length>200)return 'Select up to 200 browser tickets to import.';
          for(const old of input.tickets){
            if(!old||typeof old.pick!=='string'||typeof old.matchup!=='string'||!Number.isInteger(old.units)||old.units<1||old.units>1000)continue;
            const ticketId=randomUUID();
            const data={ticketId,pick:old.pick.slice(0,150),matchup:old.matchup.slice(0,300),units:old.units,
              sport:typeof old.sport==='string'?old.sport.slice(0,30):null,imported:true,
              placedAt:Number.isFinite(Date.parse(old.placedAt))?new Date(old.placedAt).toISOString():new Date().toISOString()};
            if(['win','loss','push'].includes(old.result))data.result=old.result;
            if(old.canceledAt)data.canceledAt=data.placedAt;
            await db.query('INSERT INTO practice_tickets VALUES($1,$2,$3)',[user.id,ticketId,data]);
          }
          await db.query('UPDATE practice_accounts SET imported=true WHERE id=$1',[user.id]);
        }
        return null;
      });
      send(error?409:200,error?{error}:{ok:true});return true;
    }
    send(404,{error:'Practice endpoint not found.'});
  }catch(error){
    console.error('Practice account request failed:',error.name,error.code||'');
    send(error instanceof SyntaxError?400:503,{error:'Practice accounts are temporarily unavailable.'});
  }
  return true;
}
