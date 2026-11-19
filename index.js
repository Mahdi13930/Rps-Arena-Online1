const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const validName = p => p && typeof p.id === 'string' && p.id.length <= 80 && typeof p.name === 'string' && p.name.trim().length >= 2 && p.name.trim().length <= 18;
const roomStub = (env, code) => env.ROOMS.get(env.ROOMS.idFromName(code));

export default {
 async fetch(request, env) {
  const url = new URL(request.url), path = url.pathname;
  if (path === '/api/health') return json({ ok: true, service: 'RPS Arena', realtime: 'Durable Objects' });
  if (path === '/api/rooms' && request.method === 'POST') {
   let body; try { body = await request.json(); } catch { return json({error:'اطلاعات ارسالی معتبر نیست.'},400); }
   const player = body?.player; if (!validName(player)) return json({error:'نام بازیکن معتبر نیست.'},400);
   for (let i=0;i<10;i++) {
    const code = String(100000 + crypto.getRandomValues(new Uint32Array(1))[0] % 900000);
    const stub = roomStub(env,code);
    const response = await stub.fetch('https://room/create',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code,player:{id:player.id,name:player.name.trim()}})});
    const data = await response.json(); if (response.ok) return json(data);
   }
   return json({error:'ساخت اتاق ممکن نشد؛ دوباره تلاش کن.'},503);
  }
  const join = path.match(/^\/api\/rooms\/(\d{6})\/join$/);
  if (join && request.method === 'POST') {
   let body; try { body = await request.json(); } catch { return json({error:'اطلاعات ارسالی معتبر نیست.'},400); }
   const player = body?.player; if (!validName(player)) return json({error:'نام بازیکن معتبر نیست.'},400);
   return roomStub(env,join[1]).fetch('https://room/join',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({player:{id:player.id,name:player.name.trim()}})});
  }
  const connect = path.match(/^\/api\/rooms\/(\d{6})\/connect$/);
  if (connect) {
   if (request.headers.get('Upgrade') !== 'websocket') return new Response('WebSocket required',{status:426});
   const id = url.searchParams.get('id') || '', name = url.searchParams.get('name') || '';
   if (!id || !name) return json({error:'اطلاعات بازیکن ارسال نشده است.'},400);
   const headers = new Headers(); headers.set('x-rps-player',JSON.stringify({id,name}));
   return roomStub(env,connect[1]).fetch(new Request('https://room/connect',{method:'GET',headers}));
  }
  if (path.startsWith('/api/')) return json({error:'مسیر API پیدا نشد.'},404);
  return env.ASSETS.fetch(request);
 }
};

export class RPSRoom {
 constructor(ctx,env) { this.ctx=ctx; this.env=env; this.room=null; this.sockets=new Map(); }
 async load() { if (!this.room) this.room = await this.ctx.storage.get('room') || null; return this.room; }
 async save() { await this.ctx.storage.put('room',this.room); }
 snapshot() {
  const r=this.room;
  return {code:r.code,status:r.status,round:r.round,players:r.players.map(p=>({...p,connected:[...this.sockets.values()].some(s=>s.id===p.id)}))};
 }
 send(ws,type,data) { try { ws.send(JSON.stringify({type,data})); } catch {} }
 broadcast(type,data) { for (const ws of this.sockets.keys()) this.send(ws,type,data); }
 broadcastRoom() { this.broadcast('room:update',this.snapshot()); }
 async fetch(request) {
  const path=new URL(request.url).pathname;
  if (path==='/create' && request.method==='POST') {
   const {code,player}=await request.json(); await this.load();
   if (this.room && this.room.status!=='closed') return json({error:'کد اتاق تکراری است.'},409);
   this.room={code:String(code),players:[player],status:'waiting',round:0,moves:{},rematchReady:[]}; await this.save();
   return json({ok:true,code:this.room.code,room:this.snapshot()});
  }
  if (path==='/join' && request.method==='POST') {
   const {player}=await request.json(); await this.load();
   if (!this.room || this.room.status==='closed') return json({error:'اتاق پیدا نشد؛ کد را بررسی کن.'},404);
   if (this.room.players.some(p=>p.id===player.id)) return json({ok:true,code:this.room.code,room:this.snapshot()});
   if (this.room.players.length>=2 || this.room.status!=='waiting') return json({error:'این اتاق ظرفیت ندارد یا مسابقه شروع شده است.'},409);
   this.room.players.push(player); this.room.status='playing'; this.room.round=1; await this.save(); this.broadcastRoom(); this.broadcast('match:started',this.snapshot());
   return json({ok:true,code:this.room.code,room:this.snapshot()});
  }
  if (path==='/connect') {
   if (request.headers.get('Upgrade')!=='websocket') return new Response('WebSocket required',{status:426});
   await this.load(); let player; try { player=JSON.parse(request.headers.get('x-rps-player')||'null'); } catch {}
   if (!player || !this.room || !this.room.players.some(p=>p.id===player.id)) return json({error:'بازیکن عضو این اتاق نیست.'},403);
   const pair=new WebSocketPair(), client=pair[0], server=pair[1]; server.accept(); this.sockets.set(server,player);
   server.addEventListener('message',e=>this.onMessage(server,player,e.data));
   server.addEventListener('close',()=>{this.sockets.delete(server);this.broadcastRoom();});
   server.addEventListener('error',()=>{this.sockets.delete(server);this.broadcastRoom();});
   this.send(server,'room:update',this.snapshot()); if(this.room.status==='playing') this.send(server,'match:started',this.snapshot()); this.broadcastRoom();
   return new Response(null,{status:101,webSocket:client});
  }
  return json({error:'مسیر اتاق پیدا نشد.'},404);
 }
 async onMessage(ws,player,raw) {
  let msg; try { msg=JSON.parse(raw); } catch { return; } await this.load();
  if (!this.room || !this.room.players.some(p=>p.id===player.id)) return;
  if (msg.type==='move') {
   if (this.room.status!=='playing') return this.send(ws,'error',{message:'مسابقه فعال نیست.'});
   if (!['rock','paper','scissors'].includes(msg.choice)) return this.send(ws,'error',{message:'حرکت نامعتبر است.'});
   if (this.room.moves[player.id]) return this.send(ws,'error',{message:'حرکتت قبلاً ثبت شده است.'});
   this.room.moves[player.id]=msg.choice; await this.save(); this.broadcastRoom();
   if (Object.keys(this.room.moves).length===2) await this.finishRound();
  }
  if (msg.type==='rematch') {
   if (this.room.status!=='finished') return;
   if (!this.room.rematchReady.includes(player.id)) this.room.rematchReady.push(player.id);
   if (this.room.rematchReady.length===2) { this.room.status='playing'; this.room.round++; this.room.moves={}; this.room.rematchReady=[]; await this.save(); this.broadcast('match:started',this.snapshot()); this.broadcastRoom(); }
   else this.broadcast('match:rematch-waiting',{name:player.name});
  }
  if (msg.type==='leave') { this.room.status='closed'; await this.save(); this.broadcast('room:closed',{message:'اتاق بسته شد.'}); }
 }
 async finishRound() {
  const [p1,p2]=this.room.players, c1=this.room.moves[p1.id], c2=this.room.moves[p2.id];
  const result=c1===c2?'draw':((c1==='rock'&&c2==='scissors')||(c1==='paper'&&c2==='rock')||(c1==='scissors'&&c2==='paper'))?'p1':'p2';
  const winnerId=result==='p1'?p1.id:result==='p2'?p2.id:null;
  this.room.status='finished'; await this.save();
  this.broadcast('match:result',{result,winnerId,choices:{[p1.id]:c1,[p2.id]:c2}}); this.broadcastRoom();
 }
}
