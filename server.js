import {practice} from './practice.js';
import http from 'node:http';
import {readFileSync} from 'node:fs';
const sports=['Basketball','Football','Baseball','Soccer','Hockey','Cricket'];
const config={Basketball:['basketball','nba'],Football:['football','nfl'],Baseball:['baseball','mlb'],Soccer:['soccer','eng.1'],Hockey:['hockey','nhl']};
const collegeConfig = {
  Basketball: ['basketball', 'mens-college-basketball', 'groups=50'],
  Football: ['football', 'college-football', 'groups=80'],
  Baseball: ['baseball', 'college-baseball'],
  Soccer: ['soccer', 'usa.ncaa.m.1'],
  Hockey: ['hockey', 'mens-college-hockey'],
};
const html=readFileSync(new URL('./index.html',import.meta.url),'utf8');
const cache=new Map();
function record(t){const text=t?.records?.find(x=>x.type==='total')?.summary||t?.records?.[0]?.summary||'';const m=text.match(/^(\d+)-(\d+)/);return {text,w:m?+m[1]:null,l:m?+m[2]:null}}
function probability(a,h){if(a.w===null||h.w===null||a.w+a.l<5||h.w+h.l<5)return null;const ap=(a.w+2)/(a.w+a.l+4),hp=(h.w+2)/(h.w+h.l+4);return Math.max(.05,Math.min(.95,.5+(hp-ap)*.65+.025))}
async function games(sport,date,level){const feeds=level==='college'?collegeConfig:config;if(!Object.hasOwn(feeds,sport))return {games:[],available:false,message:sport==='Cricket'?'Cricket feed not configured; no fixtures will be invented.':'Unsupported sport'};if(!/^\d{4}-\d{2}-\d{2}$/.test(date))throw Error('Invalid date');const key=level+sport+date;if(cache.has(key)&&Date.now()-cache.get(key).time<120000)return cache.get(key).value;const [kind,league,filter]=feeds[sport],ds=date.replaceAll('-','');const url='https://site.api.espn.com/apis/site/v2/sports/'+kind+'/'+league+'/scoreboard?dates='+ds+'&limit=100'+(filter?'&'+filter:'');const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),10000);let data;try{const res=await fetch(url,{signal:controller.signal,headers:{'user-agent':'SportsIQ-AI/1.0','accept':'application/json'}});if(!res.ok)throw Error('Provider returned '+res.status);data=await res.json()}finally{clearTimeout(timeout)}const mapped=(data.events||[]).map(e=>{const c=e.competitions?.[0]||{},home=c.competitors?.find(t=>t.homeAway==='home'),away=c.competitors?.find(t=>t.homeAway==='away');if(!home||!away)return null;const hr=record(home),ar=record(away),pre=e.status?.type?.state==='pre';return{id:e.id,date:e.date,status:e.status?.type?.description||'Scheduled',league:data.leagues?.[0]?.name||league,venue:c.venue?.fullName||'',home:{id:home.team?.id,name:home.team?.displayName||'Home',record:hr.text,color:home.team?.color||'',logo:home.team?.logo||''},away:{id:away.team?.id,name:away.team?.displayName||'Away',record:ar.text,color:away.team?.color||'',logo:away.team?.logo||''},probability:pre?probability(ar,hr):null,score:e.status?.type?.state==='pre'?'':away.score+' – '+home.score,source:e.links?.[0]?.href||'https://www.espn.com/'}}).filter(Boolean);const value={games:mapped,available:true,message:'ESPN public scoreboard · '+(data.leagues?.[0]?.name||league),fetchedAt:new Date().toISOString()};cache.set(key,{time:Date.now(),value});return value}
const injuryCache=new Map();async function nflInjuries(id){const key=String(id);if(!/^\d{1,5}$/.test(key))throw Error('Invalid team ID');const old=injuryCache.get(key);if(old&&Date.now()-old.time<300000)return old.value;const url='https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/'+key+'/injuries';const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);try{const response=await fetch(url,{signal:controller.signal,headers:{accept:'application/json'}});if(!response.ok)throw Error('Provider returned '+response.status);const data=await response.json();const entries=Array.isArray(data.injuries)?data.injuries:Array.isArray(data.items)?data.items:[];const players=entries.flatMap(x=>Array.isArray(x.injuries)?x.injuries:[x]).map(x=>({name:x.athlete?.displayName||x.athlete?.fullName||x.athlete?.name||'',headshot:x.athlete?.headshot?.href||x.athlete?.headshot||'',athleteId:String(x.athlete?.id||''),position:x.athlete?.position?.abbreviation||'Unknown',status:x.status||x.type?.description||x.details?.type||'Reported'})).filter(x=>x.name);const value={available:true,players:players.slice(0,30)};injuryCache.set(key,{time:Date.now(),value});return value}finally{clearTimeout(timer)}}
const scheduleCache = new Map();

async function teamSchedule(kind, league, team, season) {
  const key = [kind, league, team, season].join('/');
  const cached = scheduleCache.get(key);
  if (cached && Date.now() - cached.time < 3600000) return cached.events;
  const url = 'https://site.api.espn.com/apis/site/v2/sports/' +
    kind + '/' + league + '/teams/' + team + '/schedule?season=' + season;
  const response = await fetch(url, {signal: AbortSignal.timeout(12000)});
  if (!response.ok) throw Error('Schedule feed unavailable');
  const data = await response.json();
  if (!Array.isArray(data.events)) throw Error('Schedule feed unavailable');
  if (scheduleCache.size >= 512) scheduleCache.delete(scheduleCache.keys().next().value);
  scheduleCache.set(key, {time: Date.now(), events: data.events});
  return data.events;
}

async function matchupHistory(kind, league, game) {
  const cutoff = Math.min(Date.parse(game.date), Date.now());
  const year = new Date(cutoff).getUTCFullYear();
  const seasons = [year + 1, year, year - 1, year - 2, year - 3];
  const teams = [String(game.home.id), String(game.away.id)];
  const schedules = await Promise.allSettled(teams.flatMap(team =>
    seasons.map(season => teamSchedule(kind, league, team, season))));
  const completed = new Map();
  for (const schedule of schedules) {
    if (schedule.status !== 'fulfilled') continue;
    for (const event of schedule.value) {
      const competition = event.competitions?.[0];
      const date = Date.parse(competition?.date || event.date);
      if (!event.id || !(date < cutoff) || String(event.id) === String(game.id) ||
          !competition?.status?.type?.completed ||
          competition.status.type.state !== 'post') continue;
      const entries = competition.competitors || [];
      if (entries.length !== 2) continue;
      const scores = entries.map(entry => entry.score?.value ?? entry.score);
      if (scores.some(score => !['number', 'string'].includes(typeof score) ||
          String(score).trim() === '' || !Number.isFinite(Number(score)))) continue;
      const ids = entries.map(entry => String(entry.team?.id ?? entry.id));
      const [first, second] = scores.map(Number);
      completed.set(event.id, {date, ids, winner: first === second ? null : ids[first > second ? 0 : 1]});
    }
  }
  const events = [...completed.values()].sort((a, b) => b.date - a.date);
  const meetings = events.filter(event => teams.every(team => event.ids.includes(team)));
  const wins = teams.map(team => meetings.filter(event => event.winner === team).length);
  const recent = teams.map(team => {
    const sample = events.filter(event => event.ids.includes(team)).slice(0, 5);
    return {games: sample.length, wins: sample.filter(event => event.winner === team).length,
      draws: sample.filter(event => !event.winner).length};
  });
  const rates = recent.map(team => (team.wins + team.draws * .5) / team.games);
  const eligible = Date.parse(game.date) > Date.now() && !game.score;
  let pick = null;
  let basis = null;
  if (eligible && meetings.length >= 3 && wins[0] !== wins[1]) {
    pick = wins[0] > wins[1] ? 'home' : 'away';
    basis = 'head-to-head results';
  } else if (eligible && recent.every(team => team.games === 5) && rates[0] !== rates[1]) {
    pick = rates[0] > rates[1] ? 'home' : 'away';
    basis = 'last five completed games';
  }
  return {meetings: meetings.length, wins, recent, pick, basis, partial:
    schedules.some(schedule => schedule.status === 'rejected'), source: 'ESPN team schedules'};
}

async function externalConsensus(sport,id,home,away){const providers=[{name:'ESPN matchup predictor',url:sport==='Football'?'https://www.espn.com/nfl/game/_/gameId/'+id:'https://www.espn.com/',pick:null,probability:null,verified:false},{name:'Dimers',url:'https://www.dimers.com/',pick:null,probability:null,verified:false},{name:'Machine Learning Ball',url:'https://machinelearningball.com/',pick:null,probability:null,verified:false},{name:'SlipTrack',url:'https://sliptrack.bet/',pick:null,probability:null,verified:false}];if(sport==='Football'&&/^\d{7,12}$/.test(id)){const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),7000);try{const r=await fetch('https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event='+id,{signal:ctrl.signal});if(r.ok){const data=await r.json(),v=Number(data.predictor?.homeTeam?.gameProjection);if(Number.isFinite(v)&&v>=0&&v<=100&&data.predictor?.homeTeam?.gameProjection!=null){providers[0].pick=v>=50?home:away;providers[0].probability=Math.round(Math.max(v,100-v)*10)/10;providers[0].verified=true;providers[0].checkedAt=new Date().toISOString()}}}catch{}finally{clearTimeout(timer)}}return {providers,checkedAt:new Date().toISOString(),note:'Only explicitly returned pregame predictions count; other providers require permitted data access.'}}
http.createServer(async(req,res)=>{const u=new URL(req.url,'http://localhost');const send=(code,obj)=>{res.writeHead(code,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(obj))};if(u.pathname.startsWith('/api/practice/'))return practice(req,u.pathname,send,games);if(u.pathname==='/api/nfl/injuries'){const ids=[u.searchParams.get('away'),u.searchParams.get('home')];if(ids.some(x=>!/^\d{1,5}$/.test(x||'')))return send(400,{error:'Invalid team IDs'});const teams=await Promise.all(ids.map(async id=>{try{return{id,...await nflInjuries(id)}}catch{return{id,available:false,players:[]}}}));return send(200,{teams:teams.map((t,i)=>({...t,name:i===0?'Away team':'Home team'})),source:'ESPN NFL injury reports',fetchedAt:new Date().toISOString()})}if(u.pathname==='/api/consensus'){const sport=u.searchParams.get('sport')||'',id=u.searchParams.get('id')||'',home=u.searchParams.get('home')||'',away=u.searchParams.get('away')||'';if(!sports.includes(sport)||!/^\d{1,12}$/.test(id)||!home||!away||home.length>100||away.length>100)return send(400,{error:'Invalid matchup'});return send(200,await externalConsensus(u.searchParams.get('level')==='college'?'':sport,id,home,away))}if(u.pathname==='/health')return send(200,{status:'ok'});if(u.pathname==='/api/sports')return send(200,{sports,liveData:true,provider:'ESPN public scoreboard',note:'Cricket unavailable'});if(u.pathname==='/api/matchup-history'){
  const sport=u.searchParams.get('sport');
  const level=u.searchParams.get('level');
  const date=u.searchParams.get('date')||'';
  const id=u.searchParams.get('id')||'';
  const feeds=level==='college'?collegeConfig:config;
  if (!['pro','college'].includes(level)||!Object.hasOwn(feeds,sport)||
      !/^\d{4}-\d{2}-\d{2}$/.test(date)||!/^\d{1,12}$/.test(id)) {
    return send(400,{error:'Invalid matchup'});
  }
  try {
    const slate=await games(sport,date,level);
    const game=slate.games.find(game=>String(game.id)===id);
    if (!game || ![game.home.id,game.away.id].every(team=>/^\d{1,8}$/.test(String(team)))) {
      return send(404,{error:'Matchup unavailable'});
    }
    const [kind,league]=feeds[sport];
    return send(200,await matchupHistory(kind,league,game));
  } catch {
    return send(502,{error:'Historical results temporarily unavailable'});
  }
}if(u.pathname==='/api/games'){try{const sport=u.searchParams.get('sport')||'Basketball';const date=u.searchParams.get('date')||new Date().toISOString().slice(0,10);const level=u.searchParams.get('level')||'pro';if(!['pro','college'].includes(level))return send(400,{error:'Invalid competition level'});return send(200,await games(sport,date,level))}catch(e){return send(502,{error:'Unable to retrieve verified data: '+e.message})}}res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(html)}).listen(process.env.PORT||10000,'0.0.0.0');
