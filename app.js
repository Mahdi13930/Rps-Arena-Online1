(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const NAME_KEY = 'rps_arena_player_name_v2';
  const ID_KEY = 'rps_arena_player_id_v2';
  let me = null, ws = null, currentRoom = null, myChoice = null, toastTimer = null;
  const savedName = localStorage.getItem(NAME_KEY) || '';
  const playerId = localStorage.getItem(ID_KEY) || crypto.randomUUID();
  localStorage.setItem(ID_KEY, playerId);

  function toast(message) {
    const el = $('toast'); el.textContent = message; el.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
  }
  function setConnection(message, ok = false) {
    $('connectionText').textContent = message;
    const dot = document.querySelector('.live-dot'); if (dot) dot.style.background = ok ? '#35df9b' : '#ffb45b';
  }
  async function api(path, options = {}) {
    let response;
    try { response = await fetch(path, { ...options, headers: { 'content-type': 'application/json', ...(options.headers || {}) }, cache: 'no-store' }); }
    catch { throw new Error('ارتباط با سرور برقرار نشد؛ اینترنت را بررسی کن.'); }
    const raw = await response.text(); let data = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch { throw new Error(`پاسخ سرور قابل خواندن نیست (HTTP ${response.status}).`); }
    if (!response.ok) throw new Error(data.error || `خطای سرور (${response.status})`);
    return data;
  }
  function showNameModal() { $('nameModal').classList.remove('hidden'); setTimeout(() => $('playerNameInput').focus(), 100); }
  function hideNameModal() { $('nameModal').classList.add('hidden'); }
  function setPlayer(player) { me = player; $('userChip').textContent = player.name; }
  function showLobby() { $('lobbySection').classList.remove('hidden'); $('matchSection').classList.add('hidden'); $('lobbySection').scrollIntoView({behavior:'smooth',block:'start'}); }
  function updateRoom(room) {
    if (!room) return; currentRoom = room;
    $('lobbySection').classList.add('hidden'); $('matchSection').classList.remove('hidden'); $('roomCodeLabel').textContent = room.code || '------';
    const first = room.players?.[0], second = room.players?.[1];
    $('playerOneName').textContent = first?.name || me?.name || 'شما';
    $('playerOneStatus').textContent = first?.connected ? '● متصل' : 'در انتظار اتصال';
    $('playerTwoName').textContent = second?.name || 'در انتظار حریف...';
    $('playerTwoStatus').textContent = second ? (second.connected ? '● متصل' : 'اتصال قطع شده') : 'منتظر ورود بازیکن';
    $('roundLabel').textContent = room.status === 'playing' ? `دور ${room.round}` : room.status === 'finished' ? 'پایان دور' : 'در انتظار حریف';
    if (room.status === 'waiting') { $('waitingBox').classList.remove('hidden'); $('playBox').classList.add('hidden'); }
    else { $('waitingBox').classList.add('hidden'); $('playBox').classList.remove('hidden'); }
  }
  function startClientRound() {
    myChoice = null; $('resultBox').classList.add('hidden'); $('rematchBtn').classList.add('hidden');
    $('playTitle').textContent = 'حرکت خودت را انتخاب کن'; $('moveHint').textContent = 'هر دو بازیکن باید انتخاب کنند';
    document.querySelectorAll('.move-btn').forEach(b => { b.disabled = false; b.classList.remove('selected'); });
  }
  function showResult(result) {
    const winner = result.winnerId, didWin = winner === me.id, isDraw = !winner, choices = result.choices || {};
    const opponentId = Object.keys(choices).find(id => id !== me.id), fa = {rock:'سنگ',paper:'کاغذ',scissors:'قیچی'};
    const box = $('resultBox'); box.className = `result-box ${isDraw ? 'draw' : didWin ? 'win' : 'loss'}`; box.replaceChildren();
    const title = document.createElement('b'); title.textContent = isDraw ? '🤝 مساوی شد!' : didWin ? '🏆 پیروز شدی!' : 'این دور را باختی!';
    const line = document.createElement('div'); line.textContent = `حرکت تو: ${fa[choices[me.id]] || '—'} | حرکت حریف: ${fa[choices[opponentId]] || '—'}`;
    box.append(title,line); box.classList.remove('hidden');
    $('playTitle').textContent = isDraw ? 'نتیجه: مساوی' : didWin ? 'نتیجه: پیروزی تو' : 'نتیجه: پیروزی حریف';
    $('moveHint').textContent = 'برای ادامه، بازی مجدد را بزن.';
    document.querySelectorAll('.move-btn').forEach(b => b.disabled = true); $('rematchBtn').classList.remove('hidden');
  }
  function send(type,data={}) {
    if (!ws || ws.readyState !== WebSocket.OPEN) { toast('اتصال زنده برقرار نیست؛ دوباره تلاش کن.'); return false; }
    ws.send(JSON.stringify({type,...data})); return true;
  }
  function connectRoom(code) {
    if (ws) { try { ws.close(); } catch {} }
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const query = new URLSearchParams({id:me.id,name:me.name});
    ws = new WebSocket(`${scheme}://${location.host}/api/rooms/${code}/connect?${query}`);
    ws.addEventListener('open', () => setConnection('متصل',true));
    ws.addEventListener('message', event => {
      let msg; try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.type === 'room:update') updateRoom(msg.data);
      if (msg.type === 'match:started') { updateRoom(msg.data); startClientRound(); }
      if (msg.type === 'match:result') showResult(msg.data);
      if (msg.type === 'match:rematch-waiting') toast('حریف برای بازی مجدد آماده است.');
      if (msg.type === 'room:closed') { toast(msg.data?.message || 'اتاق بسته شد.'); resetMatchView(); }
      if (msg.type === 'error') toast(msg.data?.message || 'خطای مسابقه');
    });
    ws.addEventListener('close', () => setConnection('اتصال قطع شد',false));
    ws.addEventListener('error', () => setConnection('خطای اتصال',false));
  }
  function resetMatchView() {
    if (ws) { try { ws.close(); } catch {} ws = null; }
    currentRoom = null; myChoice = null; $('matchSection').classList.add('hidden'); $('lobbySection').classList.remove('hidden');
    $('waitingBox').classList.remove('hidden'); $('playBox').classList.add('hidden'); $('resultBox').classList.add('hidden'); $('roomCodeInput').value = '';
  }
  $('nameForm').addEventListener('submit', e => {
    e.preventDefault(); const name = $('playerNameInput').value.trim().replace(/\s+/g,' '); $('nameError').textContent = '';
    if (name.length < 2 || name.length > 18) { $('nameError').textContent = 'نام باید بین ۲ تا ۱۸ نویسه باشد.'; return; }
    if (!/^[\p{L}\p{N}_ -]+$/u.test(name)) { $('nameError').textContent = 'از حروف، عدد و فاصله استفاده کن.'; return; }
    localStorage.setItem(NAME_KEY,name); setPlayer({id:playerId,name}); hideNameModal(); setConnection('آماده بازی',true); showLobby();
  });
  $('goOnlineBtn').addEventListener('click', () => { if (!me) showNameModal(); else showLobby(); });
  $('createRoomBtn').addEventListener('click', async () => {
    const button = $('createRoomBtn'); button.disabled = true;
    try { const data = await api('/api/rooms',{method:'POST',body:JSON.stringify({player:me})}); updateRoom(data.room); connectRoom(data.code); toast(`اتاق ${data.code} ساخته شد؛ کد را برای دوستت بفرست.`); }
    catch(e) { toast(e.message); } finally { button.disabled = false; }
  });
  $('joinRoomBtn').addEventListener('click', async () => {
    const code = $('roomCodeInput').value.replace(/\D/g,'').slice(0,6); if (code.length !== 6) return toast('کد اتاق باید دقیقاً ۶ رقم باشد.');
    const button = $('joinRoomBtn'); button.disabled = true;
    try { const data = await api(`/api/rooms/${code}/join`,{method:'POST',body:JSON.stringify({player:me})}); updateRoom(data.room); connectRoom(code); toast('به اتاق متصل شدی.'); }
    catch(e) { toast(e.message); } finally { button.disabled = false; }
  });
  $('roomCodeInput').addEventListener('input',e => e.target.value = e.target.value.replace(/\D/g,'').slice(0,6));
  $('copyCodeBtn').addEventListener('click', async () => { const code = currentRoom?.code || $('roomCodeLabel').textContent; try { await navigator.clipboard.writeText(code); toast('کد اتاق کپی شد.'); } catch { toast(`کد اتاق: ${code}`); } });
  document.querySelectorAll('.move-btn').forEach(button => button.addEventListener('click',() => {
    if (myChoice) return; myChoice = button.dataset.choice; button.classList.add('selected'); document.querySelectorAll('.move-btn').forEach(b => b.disabled = true);
    $('playTitle').textContent = 'حرکت ثبت شد!'; $('moveHint').textContent = 'منتظر انتخاب حریف هستیم...';
    if (!send('move',{choice:myChoice})) { myChoice = null; document.querySelectorAll('.move-btn').forEach(b => b.disabled = false); }
  }));
  $('rematchBtn').addEventListener('click',() => { if (send('rematch')) { $('rematchBtn').classList.add('hidden'); toast('درخواست بازی مجدد ثبت شد.'); } });
  $('leaveRoomBtn').addEventListener('click',() => { send('leave'); resetMatchView(); toast('از اتاق خارج شدی.'); });

  if (savedName) { setPlayer({id:playerId,name:savedName}); setConnection('آماده بازی',true); showLobby(); }
  else showNameModal();
})();
