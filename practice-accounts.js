import {createHash, randomBytes, randomUUID} from 'node:crypto';
import pg from 'pg';

const {DATABASE_URL, RESEND_API_KEY, PRACTICE_FROM_EMAIL, PUBLIC_ORIGIN} = process.env;
const ready = Boolean(DATABASE_URL && RESEND_API_KEY && PRACTICE_FROM_EMAIL && PUBLIC_ORIGIN);
const pool = ready ? new pg.Pool({connectionString: DATABASE_URL, max: 5}) : null;
const digest = value => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const cookie = (value, age) => '__Host-practice='+value+'; Path=/; Max-Age='+age+'; Secure; HttpOnly; SameSite=Lax';
let schema;
const initialize = () => schema ??= pool.query(`
CREATE TABLE IF NOT EXISTS practice_accounts (
  id uuid PRIMARY KEY, email text UNIQUE NOT NULL, imported boolean NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS practice_tokens (
  hash text PRIMARY KEY, email text NOT NULL, expires timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS practice_token_email ON practice_tokens(email,expires);
CREATE TABLE IF NOT EXISTS practice_sessions (
  hash text PRIMARY KEY, account_id uuid NOT NULL REFERENCES practice_accounts(id), expires timestamptz NOT NULL
);
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
    await initialize();
    if(req.method==='POST'&&req.headers.origin!==PUBLIC_ORIGIN){
      send(403,{error:'Invalid request origin.'});return true;
    }
    if(route==='request'&&req.method==='POST'){
      const {email:raw}=await body(req);
      const email=typeof raw==='string'?raw.trim().toLowerCase():'';
      if(email.length>254||!/^\S+@[^\s@]+\.[^\s@]+$/.test(email)){
        send(400,{error:'Enter a valid email address.'});return true;
      }
      const secret=token(),hash=digest(secret);
      const issued=await transaction(async db=>{
        await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',[email]);
        const recent=await db.query("SELECT 1 FROM practice_tokens WHERE email=$1 AND expires>now()+interval '13 minutes'",[email]);
        if(recent.rowCount)return false;
        await db.query("SELECT pg_advisory_xact_lock(74263109)");
        const volume=await db.query("SELECT count(*)::int AS count FROM practice_tokens WHERE expires>now()+interval '14 minutes'");
        if(volume.rows[0].count>=10)return false;
        await db.query("INSERT INTO practice_tokens VALUES($1,$2,now()+interval '15 minutes')",[hash,email]);
        return true;
      });
      if(issued){
        const link=new URL('/#practice-sign-in='+secret,PUBLIC_ORIGIN).href;
        try{
          const response=await fetch('https://api.resend.com/emails',{
            method:'POST',signal:AbortSignal.timeout(10000),
            headers:{Authorization:'Bearer '+RESEND_API_KEY,'Content-Type':'application/json'},
            body:JSON.stringify({from:PRACTICE_FROM_EMAIL,to:[email],subject:'Sign in to Sports IQ Practice Bets',
              text:'Open this link and choose Complete sign-in. It expires in 15 minutes.\n\n'+link}),
          });
          if(!response.ok)throw Error('Email unavailable');
        }catch(error){await pool.query('DELETE FROM practice_tokens WHERE hash=$1',[hash]);throw error}
      }
      send(200,{message:'Check your inbox for a sign-in link. If you just requested one, use the previous email.'});
      return true;
    }
    if(route==='verify'&&req.method==='POST'){
      const {code}=await body(req);
      if(typeof code!=='string'||!/^[-_\w]{43}$/.test(code)){send(400,{error:'Invalid sign-in link.'});return true}
      const session=token();
      const account=await transaction(async db=>{
        const used=await db.query('DELETE FROM practice_tokens WHERE hash=$1 AND expires>now() RETURNING email',[digest(code)]);
        if(!used.rowCount)return null;
        const {email}=used.rows[0];
        const user=await db.query('INSERT INTO practice_accounts(id,email) VALUES($1,$2) ON CONFLICT(email) DO UPDATE SET email=excluded.email RETURNING id',[randomUUID(),email]);
        await db.query("INSERT INTO practice_sessions VALUES($1,$2,now()+interval '30 days')",[digest(session),user.rows[0].id]);
        return user.rows[0].id;
      });
      if(!account){send(400,{error:'This link expired or was already used.'});return true}
      res.setHeader('Set-Cookie',cookie(session,2592000));
      send(200,{ok:true});return true;
    }
    const session=(req.headers.cookie||'').match(/(?:^|;\s*)__Host-practice=([-_\w]{43})(?:;|$)/)?.[1];
    const user=session&&(await pool.query(`SELECT a.id,a.email,a.imported FROM practice_accounts a
      JOIN practice_sessions s ON s.account_id=a.id WHERE s.hash=$1 AND s.expires>now()`,[digest(session)])).rows[0];
    if(!user){send(401,{error:'Sign in to save practice bets.'});return true}
    if(route==='logout'&&req.method==='POST'){
      await pool.query('DELETE FROM practice_sessions WHERE hash=$1',[digest(session)]);
      res.setHeader('Set-Cookie',cookie('',0));send(200,{ok:true});return true;
    }
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
