const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
const now = () => new Date().toISOString();
const validChoice = c => ['rock', 'paper', 'scissors'].includes(c);
const publicPlayer = p => ({ id: p.id, name: p.name, rating: p.rating, wins: p.wins, losses: p.losses, draws: p.draws, matches: p.matches });
async function sha(value) { const bytes = new TextEncoder().encode(value); const digest = await crypto.subtle.digest('SHA-256', bytes); return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join(''); }
function tokenFrom(request) { const h = request.headers.get('authorization') || ''; if (h.startsWith('Bearer ')) return h.slice(7); return new URL(request.url).searchParams.get('token') || ''; }
async function getPlayer(request, env) { const token = tokenFrom(request); if (token.length < 32) return null; const hash = await sha(token); const p = await env.DB.prepare('SELECT id,name,rating,wins,losses,draws,matches FROM players WHERE token_hash=?').bind(hash).first(); if (p) await env.DB.prepare('UPDATE players SET last_seen=? WHERE id=?').bind(now(), p.id).run(); return p; }
function roomStub(env, code) { return env.ROOMS.get(env.ROOMS.idFromName(code)); }

export default {
 async fetch(request, env) {
  const url = new URL(request.url); const path = url.pathname;
  if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders(request) });
  if (path === '/api/health') return json({ ok: true, service: 'RPS Arena Online', database: 'D1', realtime: 'Durable Objects', time: now() });
  if (path === '/api/register' && request.method === 'POST') {
   let body; try { body = await request.json(); } catch { return json({ error: 'اطلاعات ارسالی معتبر نیست.' }, 400); }
   const name = String(body?.name || '').trim().replace(/\s+/g, ' ');
   if (name.length < 2 || name.length > 18 || !/^[\p{L}\p{N}_ -]+$/u.test(name)) return json({ error: 'نام باید ۲ تا ۱۸ نویسه و فقط شامل حروف، عدد، فاصله، خط تیره یا زیرخط باشد.' }, 400);
   const normalized = name.toLocaleLowerCase('en-US');
   const exists = await env.DB.prepare('SELECT id FROM players WHERE normalized_name=?').bind(normalized).first();
   if (exists) return json({ error: 'این نام قبلاً ثبت شده است؛ یک نام دیگر انتخاب کن.' }, 409);
   const id = crypto.randomUUID(); const token = [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join(''); const stamp = now();
   try { await env.DB.prepare('INSERT INTO players (id,name,normalized_name,token_hash,created_at,last_seen) VALUES (?,?,?,?,?,?)').bind(id, name, normalized, await sha(token), stamp, stamp).run(); }
   catch (e) { return json({ error: 'ثبت نام انجام نشد؛ ممکن است این نام قبلاً ثبت شده باشد.' }, 409); }
   const player = await env.DB.prepare('SELECT id,name,rating,wins,losses,draws,matches FROM players WHERE id=?').bind(id).first();
   return json({ token, player: publicPlayer(player) }, 201);
  }
  if (path === '/api/me') { const p = await getPlayer(request, env); return p ? json({ player: publicPlayer(p) }) : json({ error: 'برای ادامه نام بازیکن را ثبت کن.' }, 401); }
  if (path === '/api/leaderboard') {
   const { results } = await env.DB.prepare(`SELECT id,name,rating,wins,losses,draws,matches,CASE WHEN matches=0 THEN 0 ELSE ROUND(wins*100.0/matches,1) END AS winRate FROM players ORDER BY rating DESC,wins DESC,matches ASC,created_at ASC LIMIT 100`).all();
   return json({ players: results.map((p, i) => ({ rank: i + 1, ...p })) });
  }
  if (path === '/api/recent-matches') {
   const p = await getPlayer(request, env); if (!p) return json({ error: 'ابتدا وارد حساب شو.' }, 401);
   const { results } = await env.DB.prepare(`SELECT m.id,m.room_code,m.result,m.played_at,m.rating_change1,m.rating_change2,m.player1_id,m.winner_id,p1.name AS player1,p2.name AS player2 FROM matches m JOIN players p1 ON p1.id=m.player1_id JOIN players p2 ON p2.id=m.player2_id WHERE m.player1_id=? OR m.player2_id=? ORDER BY m.id DESC LIMIT 12`).bind(p.id,p.id).all();
   return json({ matches: results.map(m => ({ ...m, myRatingChange: m.player1_id === p.id ? m.rating_change1 : m.rating_change2, outcome: !m.winner_id ? 'draw' : m.winner_id === p.id ? 'win' : 'loss' })) });
  }
  if (path === '/api/rooms' && request.method === 'POST') {
   const p = await getPlayer(request, env); if (!p) return json({ error: 'ابتدا نام بازیکن را ثبت کن.' }, 401);
   for (let i=0;i<8;i++) { const code = String(100000 + crypto.getRandomValues(new Uint32Array(1))[0] % 900000); const stub = roomStub(env, code); const r = await stub.fetch('https://room/create', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ code, player: publicPlayer(p) }) }); const data = await r.json(); if (r.ok) return json(data); }
   return json({ error: 'ساخت اتاق ممکن نشد؛ دوباره تلاش کن.' }, 503);
  }
  const joinMatch = path.match(/^\/api\/rooms\/(\d{6})\/join$/);
  if (joinMatch && request.method === 'POST') {
   const p = await getPlayer(request, env); if (!p) return json({ error: 'ابتدا نام بازیکن را ثبت کن.' }, 401);
   const stub = roomStub(env, joinMatch[1]); return stub.fetch('https://room/join', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ player: publicPlayer(p) }) });
  }
  const connectMatch = path.match(/^\/api\/rooms\/(\d{6})\/connect$/);
  if (connectMatch) {
   const p = await getPlayer(request, env); if (!p) return json({ error: 'نشست معتبر نیست.' }, 401);
   const stub = roomStub(env, connectMatch[1]); const headers = new Headers(request.headers); headers.set('x-rps-player', JSON.stringify(publicPlayer(p)));
   const target = new URL('https://room/connect'); target.search = url.search;
   return stub.fetch(new Request(target, { method: 'GET', headers }));
  }
  if (path.startsWith('/api/')) return json({ error: 'مسیر API پیدا نشد.' }, 404);
  return env.ASSETS.fetch(request);
 },
};
function corsHeaders(request) { const origin = request.headers.get('Origin') || '*'; return { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'Content-Type,Authorization', 'vary': 'Origin' }; }

export class RPSRoom {
 constructor(ctx, env) { this.ctx=ctx; this.env=env; this.room=null; this.sockets=new Map(); }
 async load() { if (!this.room) this.room = await this.ctx.storage.get('room') || null; return this.room; }
 async save() { await this.ctx.storage.put('room', this.room); }
 snapshot() { const r=this.room; return { code:r.code,status:r.status,round:r.round,players:r.players.map(p=>({...p,connected:[...this.sockets.values()].some(s=>s.id===p.id)})),movesSubmitted:Object.keys(r.moves||{}).length }; }
 send(ws, type, data) { try { ws.send(JSON.stringify({type,data})); } catch {} }
 broadcast(type,data) { for (const ws of this.sockets.keys()) this.send(ws,type,data); }
 broadcastRoom() { this.broadcast('room:update',this.snapshot()); }
 async fetch(request) {
  const url=new URL(request.url); const path=url.pathname;
  if (path==='/create' && request.method==='POST') { const {code,player}=await request.json(); await this.load(); if (this.room && this.room.status!=='closed') return json({error:'کد اتاق تکراری است.'},409); this.room={code:String(code),players:[player],status:'waiting',round:0,moves:{},rematchReady:[],createdAt:now()}; await this.save(); return json({ok:true,code:this.room.code,room:this.snapshot()}); }
  if (path==='/join' && request.method==='POST') { const {player}=await request.json(); await this.load(); if (!this.room) return json({error:'اتاق پیدا نشد؛ کد را بررسی کن.'},404); if (this.room.players.some(p=>p.id===player.id)) return json({ok:true,code:this.room.code,room:this.snapshot()}); if (this.room.players.length>=2 || this.room.status!=='waiting') return json({error:'این اتاق ظرفیت ندارد یا مسابقه شروع شده است.'},409); this.room.players.push(player); this.room.status='playing'; this.room.round=1; await this.save(); this.broadcastRoom(); this.broadcast('match:started',this.snapshot()); return json({ok:true,code:this.room.code,room:this.snapshot()}); }
  if (path==='/connect') {
   if (request.headers.get('Upgrade')!=='websocket') return new Response('WebSocket required',{status:426}); await this.load(); const player=JSON.parse(request.headers.get('x-rps-player')||'null'); if (!player || !this.room || !this.room.players.some(p=>p.id===player.id)) return json({error:'بازیکن عضو این اتاق نیست.'},403);
   const pair=new WebSocketPair(); const client=pair[0], server=pair[1]; server.accept(); this.sockets.set(server,player); server.addEventListener('message',e=>this.onMessage(server,player,e.data)); server.addEventListener('close',()=>{this.sockets.delete(server);this.broadcastRoom();}); server.addEventListener('error',()=>{this.sockets.delete(server);this.broadcastRoom();}); this.send(server,'room:update',this.snapshot()); if(this.room.status==='playing') this.send(server,'match:started',this.snapshot()); this.broadcastRoom(); return new Response(null,{status:101,webSocket:client});
  }
  return json({error:'مسیر اتاق پیدا نشد.'},404);
 }
 async onMessage(ws,player,raw) { let msg; try{msg=JSON.parse(raw)}catch{return} await this.load(); if(!this.room || !this.room.players.some(p=>p.id===player.id)) return;
  if(msg.type==='move') { if(this.room.status!=='playing') return this.send(ws,'error',{message:'مسابقه فعال نیست.'}); if(!['rock','paper','scissors'].includes(msg.choice)) return this.send(ws,'error',{message:'حرکت نامعتبر است.'}); if(this.room.moves[player.id]) return this.send(ws,'error',{message:'حرکتت قبلاً ثبت شده است.'}); this.room.moves[player.id]=msg.choice; await this.save(); this.broadcastRoom(); if(Object.keys(this.room.moves).length===2) await this.finishRound(); }
  if(msg.type==='rematch') { if(this.room.status!=='finished') return; if(!this.room.rematchReady.includes(player.id)) this.room.rematchReady.push(player.id); if(this.room.rematchReady.length===2) {this.room.status='playing';this.room.round++;this.room.moves={};this.room.rematchReady=[];await this.save();this.broadcast('match:started',this.snapshot());this.broadcastRoom();} else this.broadcast('match:rematch-waiting',{name:player.name}); }
  if(msg.type==='leave') { this.room.status='closed'; await this.save(); this.broadcast('room:closed',{message:'اتاق بسته شد.'}); }
 }
 async finishRound() { const [p1,p2]=this.room.players; const c1=this.room.moves[p1.id],c2=this.room.moves[p2.id]; const result=c1===c2?'draw':((c1==='rock'&&c2==='scissors')||(c1==='paper'&&c2==='rock')||(c1==='scissors'&&c2==='paper'))?'p1':'p2';
  const a=await this.env.DB.prepare('SELECT rating FROM players WHERE id=?').bind(p1.id).first(); const b=await this.env.DB.prepare('SELECT rating FROM players WHERE id=?').bind(p2.id).first(); if(!a||!b)return;
  const expected=1/(1+Math.pow(10,((b.rating||1000)-(a.rating||1000))/400)); const score=result==='p1'?1:result==='p2'?0:0.5; const d1=Math.round(32*(score-expected)),d2=-d1; const winnerId=result==='p1'?p1.id:result==='p2'?p2.id:null; const stamp=now();
  const update=(id,delta,win,loss)=>this.env.DB.prepare('UPDATE players SET rating=MAX(100,rating+?),wins=wins+?,losses=losses+?,draws=draws+?,matches=matches+1,last_seen=? WHERE id=?').bind(delta,win?1:0,loss?1:0,result==='draw'?1:0,stamp,id);
  const insert=this.env.DB.prepare('INSERT INTO matches(room_code,player1_id,player2_id,player1_choice,player2_choice,winner_id,result,rating_change1,rating_change2,played_at) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(this.room.code,p1.id,p2.id,c1,c2,winnerId,result,d1,d2,stamp);
  await this.env.DB.batch([update(p1.id,d1,result==='p1',result==='p2'),update(p2.id,d2,result==='p2',result==='p1'),insert]);
  const fresh=await this.env.DB.prepare('SELECT id,name,rating,wins,losses,draws,matches FROM players WHERE id IN (?,?)').bind(p1.id,p2.id).all(); const byId=Object.fromEntries(fresh.results.map(p=>[p.id,publicPlayer(p)]));
  this.room.status='finished'; await this.save(); this.broadcast('match:result',{result,winnerId,choices:{[p1.id]:c1,[p2.id]:c2},ratingChanges:{[p1.id]:d1,[p2.id]:d2},players:[byId[p1.id],byId[p2.id]]}); this.broadcastRoom();
 }
}
