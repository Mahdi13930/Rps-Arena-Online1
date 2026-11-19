'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const tokenKey = 'rpsArenaOnlineToken';
  let token = localStorage.getItem(tokenKey) || '';
  let me = null;
  let socket = null;
  let currentRoom = null;
  let myChoice = null;
  let toastTimer = null;
  const choiceFa = { rock: 'سنگ ✊', paper: 'کاغذ ✋', scissors: 'قیچی ✌️' };

  function toast(message) {
    const el = $('toast'); el.textContent = message; el.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
  }
  async function api(url, options = {}) {
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(url, { ...options, headers });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'خطایی رخ داد. دوباره تلاش کن.');
    return data;
  }
  function showNameModal() { $('nameModal').classList.remove('hidden'); setTimeout(() => $('playerNameInput').focus(), 100); }
  function hideNameModal() { $('nameModal').classList.add('hidden'); }
  function setConnection(text, online) { $('connectionText').textContent = text; document.querySelector('.live-dot').style.background = online ? '#43d6a1' : '#ff7189'; }
  function setPlayer(player) {
    me = player; $('userChip').textContent = player.name; $('playerOneName').textContent = player.name;
    $('playerOneRating').textContent = `${player.rating} RP`;
  }
  function connectSocket() {
    if (socket) socket.disconnect();
    socket = io({ auth: { token }, reconnection: true, reconnectionAttempts: Infinity, reconnectionDelay: 900 });
    socket.on('connect', () => setConnection('متصل به سرور', true));
    socket.on('disconnect', () => setConnection('اتصال قطع شد', false));
    socket.on('connect_error', err => { setConnection('خطای اتصال', false); toast(err.message || 'اتصال به سرور برقرار نشد.'); });
    socket.on('online:welcome', payload => { if (payload.player) setPlayer(payload.player); updateOnlineCount(payload.onlinePlayers); });
    socket.on('presence:update', payload => updateOnlineCount(payload.onlinePlayers));
    socket.on('room:update', updateRoom);
    socket.on('match:started', room => { updateRoom(room); startClientRound(); });
    socket.on('match:result', showResult);
    socket.on('match:rematch-waiting', data => toast(`${data.name || 'حریف'} آماده بازی مجدد است؛ منتظر انتخاب توست.`));
    socket.on('room:player-disconnected', room => { updateRoom(room); toast('اتصال حریف قطع شد؛ منتظر بازگشت او بمان.'); });
    socket.on('room:closed', data => { toast(data.message || 'اتاق بسته شد.'); resetMatchView(); });
    socket.on('room:error', data => toast(data.message || 'خطای اتاق'));
  }
  function switchPage(page) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    $(page === 'ranking' ? 'rankingPage' : 'homePage').classList.add('active');
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.page === page));
    if (page === 'ranking') loadRanking();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  function showLobby() {
    $('lobbySection').classList.remove('hidden');
    $('lobbySection').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function updateOnlineCount(count) { $('onlineCount').textContent = Number(count || 0).toLocaleString('fa-IR'); }
  function rankTitle(rating) {
    if (rating >= 2200) return 'Grandmaster'; if (rating >= 2000) return 'Master'; if (rating >= 1800) return 'Diamond';
    if (rating >= 1600) return 'Platinum'; if (rating >= 1400) return 'Gold'; if (rating >= 1200) return 'Silver'; return 'Bronze';
  }
  function updateRoom(room) {
    if (!room) return; currentRoom = room; myChoice = myChoice;
    $('lobbySection').classList.add('hidden'); $('matchSection').classList.remove('hidden');
    $('roomCodeLabel').textContent = room.code;
    const first = room.players?.[0], second = room.players?.[1];
    $('playerOneName').textContent = first?.name || me?.name || 'شما';
    $('playerOneRating').textContent = first ? `${first.rating} RP · ${rankTitle(first.rating)}` : '— RP';
    $('playerOneStatus').textContent = first?.connected ? '● متصل' : 'در انتظار اتصال';
    $('playerTwoName').textContent = second?.name || 'در انتظار حریف...';
    $('playerTwoRating').textContent = second ? `${second.rating} RP · ${rankTitle(second.rating)}` : '— RP';
    $('playerTwoStatus').textContent = second ? (second.connected ? '● متصل' : 'اتصال قطع شده') : 'منتظر ورود بازیکن';
    $('roundLabel').textContent = room.status === 'playing' ? `دور ${room.round}` : room.status === 'finished' ? 'پایان دور' : 'در انتظار حریف';
    if (room.status === 'waiting') { $('waitingBox').classList.remove('hidden'); $('playBox').classList.add('hidden'); }
    if (room.status === 'playing') { $('waitingBox').classList.add('hidden'); $('playBox').classList.remove('hidden'); }
    if (room.status === 'finished') { $('waitingBox').classList.add('hidden'); $('playBox').classList.remove('hidden'); }
  }
  function startClientRound() {
    myChoice = null; $('resultBox').classList.add('hidden'); $('rematchBtn').classList.add('hidden');
    $('playTitle').textContent = 'حرکت خودت را انتخاب کن'; $('moveHint').textContent = 'هر دو بازیکن باید انتخاب کنند';
    document.querySelectorAll('.move-btn').forEach(b => { b.disabled = false; b.classList.remove('selected'); });
  }
  function showResult(result) {
    const winner = result.winnerId;
    const didWin = winner === me.id;
    const isDraw = !winner;
    const delta = result.ratingChanges?.[me.id] ?? 0;
    const myMove = result.choices?.[me.id];
    const opponentId = Object.keys(result.choices || {}).find(id => id !== me.id);
    const opponentMove = result.choices?.[opponentId];
    const box = $('resultBox'); box.className = `result-box ${isDraw ? 'draw' : didWin ? 'win' : 'loss'}`;
    box.innerHTML = `<b>${isDraw ? '🤝 مساوی شد!' : didWin ? '🏆 پیروز شدی!' : 'این دور را باختی!'}</b><div>حرکت تو: ${choiceFa[myMove] || '—'} &nbsp; | &nbsp; حرکت حریف: ${choiceFa[opponentMove] || '—'}</div><small>تغییر امتیاز رنک: ${delta > 0 ? '+' : ''}${delta} RP</small>`;
    box.classList.remove('hidden'); $('playTitle').textContent = isDraw ? 'نتیجه دور: مساوی' : didWin ? 'نتیجه دور: پیروزی تو' : 'نتیجه دور: پیروزی حریف';
    $('moveHint').textContent = 'نتیجه مسابقه در رنکینگ ثبت شد.';
    document.querySelectorAll('.move-btn').forEach(b => b.disabled = true);
    $('rematchBtn').classList.remove('hidden'); $('rematchBtn').textContent = 'بازی مجدد';
    api('/api/me').then(data => setPlayer(data.player)).catch(() => {});
    loadRanking();
  }
  function resetMatchView() {
    currentRoom = null; myChoice = null; $('matchSection').classList.add('hidden'); $('lobbySection').classList.remove('hidden');
    $('waitingBox').classList.remove('hidden'); $('playBox').classList.add('hidden'); $('resultBox').classList.add('hidden');
    $('roomCodeInput').value = '';
  }
  function emitAck(event, data = {}) {
    return new Promise(resolve => {
      if (!socket?.connected) return resolve({ ok: false, error: 'اتصال به سرور برقرار نیست.' });
      socket.emit(event, data, response => resolve(response || { ok: false, error: 'پاسخی از سرور دریافت نشد.' }));
    });
  }
  async function loadRanking() {
    try {
      const data = await api('/api/leaderboard');
      const body = $('rankingBody'); body.innerHTML = '';
      $('rankingEmpty').classList.toggle('hidden', data.players.length > 0);
      if (!data.players.length) { body.innerHTML = '<tr><td colspan="7" class="empty-cell">هنوز بازیکنی ثبت نشده است.</td></tr>'; return; }
      data.players.forEach(p => {
        const tr = document.createElement('tr');
        const values = [p.rank, p.name, `${p.rating} RP · ${rankTitle(p.rating)}`, p.wins, p.losses, p.matches, `${p.winRate}%`];
        values.forEach((value, i) => { const td = document.createElement('td'); td.textContent = value; if (i === 0) td.className = 'rank-number'; if (i === 1) td.className = 'rank-name'; if (i === 2) td.className = 'rating-cell'; tr.appendChild(td); });
        body.appendChild(tr);
      });
    } catch (err) { $('rankingBody').innerHTML = `<tr><td colspan="7" class="empty-cell">${err.message}</td></tr>`; }
  }

  $('nameForm').addEventListener('submit', async event => {
    event.preventDefault(); $('nameError').textContent = '';
    const name = $('playerNameInput').value.trim();
    try {
      const data = await api('/api/register', { method: 'POST', body: JSON.stringify({ name }) });
      token = data.token; localStorage.setItem(tokenKey, token); setPlayer(data.player); hideNameModal(); connectSocket(); toast(`خوش آمدی ${data.player.name}!`);
    } catch (err) { $('nameError').textContent = err.message; }
  });
  document.querySelectorAll('.nav-btn').forEach(b => b.addEventListener('click', () => switchPage(b.dataset.page)));
  $('goOnlineBtn').addEventListener('click', () => { if (!me) return showNameModal(); showLobby(); });
  $('showRankingBtn').addEventListener('click', () => switchPage('ranking'));
  $('bottomRankingBtn').addEventListener('click', () => switchPage('ranking'));
  $('refreshRankingBtn').addEventListener('click', loadRanking);
  $('createRoomBtn').addEventListener('click', async () => {
    const result = await emitAck('room:create');
    if (!result.ok) return toast(result.error);
    updateRoom(result.room); toast(`اتاق ${result.code} ساخته شد؛ کد را برای دوستت بفرست.`);
  });
  $('joinRoomBtn').addEventListener('click', async () => {
    const code = $('roomCodeInput').value.replace(/\D/g, '').slice(0, 6);
    if (code.length !== 6) return toast('کد اتاق باید دقیقاً ۶ رقم باشد.');
    const result = await emitAck('room:join', { code });
    if (!result.ok) return toast(result.error);
    updateRoom(result.room); toast('با موفقیت به اتاق متصل شدی.');
  });
  $('roomCodeInput').addEventListener('input', e => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6); });
  $('copyCodeBtn').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(currentRoom?.code || $('roomCodeLabel').textContent); toast('کد اتاق کپی شد.'); }
    catch { toast(`کد اتاق: ${currentRoom?.code || $('roomCodeLabel').textContent}`); }
  });
  document.querySelectorAll('.move-btn').forEach(button => button.addEventListener('click', async () => {
    if (myChoice) return;
    myChoice = button.dataset.choice; button.classList.add('selected');
    document.querySelectorAll('.move-btn').forEach(b => b.disabled = true);
    $('playTitle').textContent = 'حرکت ثبت شد!'; $('moveHint').textContent = 'منتظر انتخاب حریف هستیم...';
    const result = await emitAck('match:move', { choice: myChoice });
    if (!result.ok) { myChoice = null; document.querySelectorAll('.move-btn').forEach(b => b.disabled = false); toast(result.error); }
  }));
  $('rematchBtn').addEventListener('click', async () => {
    $('rematchBtn').disabled = true; const result = await emitAck('match:rematch'); $('rematchBtn').disabled = false;
    if (!result.ok) return toast(result.error); $('rematchBtn').classList.add('hidden'); toast('درخواست بازی مجدد ثبت شد. منتظر حریف بمان.');
  });
  $('leaveRoomBtn').addEventListener('click', async () => { await emitAck('room:leave'); resetMatchView(); toast('از اتاق خارج شدی.'); });

  async function boot() {
    if (!token) return showNameModal();
    try { const data = await api('/api/me'); setPlayer(data.player); connectSocket(); }
    catch { localStorage.removeItem(tokenKey); token = ''; showNameModal(); }
  }
  boot();
})();
