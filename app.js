/* Państwa Miasta: gra online (MQTT przez WebSocket) i offline (jeden telefon) */
(function () {
  'use strict';
  const D = window.PM_DICT;
  const APP_VER = '1.0.0';
  const BROKERS = window.PM_BROKERS || [
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker.hivemq.com:8884/mqtt',
    'wss://test.mosquitto.org:8081/mqtt',
  ];
  const TOPIC = (code) => 'pmsr26/v1/' + code;
  const BASE_LETTERS = 'ABCDEFGHIJKLMNOPRSTUWZ';
  const PL_LETTERS = 'ŁŚŻ';
  const TIMES = [30, 60, 90, 120, 180, 0];

  // ---------- pomocnicze ----------
  const $ = (s, el = document) => el.querySelector(s);
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        const v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'html') el.innerHTML = v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else if (k === 'value') el.value = v;
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const c of kids.flat(3)) {
      if (c == null || c === false) continue;
      el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
    }
    return el;
  }
  const store = {
    get(k, d) { try { const v = localStorage.getItem('pm_' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('pm_' + k, JSON.stringify(v)); } catch (e) {} },
    del(k) { try { localStorage.removeItem('pm_' + k); } catch (e) {} },
  };
  const rid = (n = 8) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');
  function makeCode(bi) {
    const A = 'ABCDEFGHJKLMNPRSTUWXYZ';
    let s = '';
    for (const b of crypto.getRandomValues(new Uint8Array(4))) s += A[b % A.length];
    return s + bi;
  }
  let toastT;
  function toast(msg, ms = 2200) {
    let t = $('.toast');
    if (!t) { t = h('div', { class: 'toast' }); document.body.appendChild(t); }
    t.textContent = msg;
    t.style.display = 'block';
    clearTimeout(toastT);
    toastT = setTimeout(() => (t.style.display = 'none'), ms);
  }
  const fmt = (ms) => {
    if (ms == null) return '∞';
    const s = Math.max(0, Math.ceil(ms / 1000));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  };
  function vibrate(p) { try { navigator.vibrate && navigator.vibrate(p); } catch (e) {} }
  let wakeLock = null;
  async function keepAwake(on) {
    try {
      if (on && !wakeLock && navigator.wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => (wakeLock = null)); }
      if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
    } catch (e) {}
  }

  // ---------- ustawienia lokalne ----------
  const me = { id: store.get('id') || rid(10), name: store.get('name', '') };
  store.set('id', me.id);
  function applyTheme() { document.documentElement.classList.toggle('light', store.get('theme', 'dark') === 'light'); }
  applyTheme();

  const defaultSettings = () => ({
    time: 90,
    endMode: 'first', // first: pierwszy "Zakończ" kończy rundę; all: gdy wszyscy klikną
    cats: ['panstwo', 'miasto', 'rzecz', 'zwierze', 'kolor', 'imie'],
    custom: [],
    plLetters: false,
    noRepeat: true,
    foldLetters: false,
  });
  function allCats(s) { return D.CATS.concat((s.custom || []).map((c) => ({ id: c.id, name: c.name, icon: '✏️' }))); }
  function catById(s, id) { return allCats(s).find((c) => c.id === id); }
  function letterPool(s, used) {
    let pool = (BASE_LETTERS + (s.plLetters ? PL_LETTERS : '')).split('');
    if (s.noRepeat && used && used.length) {
      const left = pool.filter((l) => !used.includes(l));
      if (left.length) pool = left;
    }
    return pool;
  }

  // ---------- punktacja (wspólna dla online i offline) ----------
  function scoreRound(R, settings) {
    const out = { cells: {}, totals: {} };
    const pids = Object.keys(R.ans || {});
    pids.forEach((p) => { out.cells[p] = {}; out.totals[p] = 0; });
    for (const cat of R.cats) {
      const valid = [];
      for (const p of pids) {
        const txt = ((R.ans[p] || {})[cat.id] || '').trim();
        const key = cat.id + '|' + p;
        let st, ok = false, note = '';
        if (!txt) { st = 'empty'; }
        else {
          const first = txt[0].toLocaleUpperCase('pl');
          const letterOk = settings.foldLetters ? D.fold(first) === D.fold(R.letter) : first === R.letter;
          if (!letterOk) { st = 'bad'; note = 'zła litera'; }
          else {
            const d = D.has(cat.id, txt);
            if (d === true) { st = 'ok'; ok = true; note = 'w słowniku'; }
            else {
              const v = (R.votes || {})[key] || {};
              let yes = 0, no = 0;
              for (const k in v) { if (v[k] > 0) yes++; else if (v[k] < 0) no++; }
              ok = yes >= no;
              st = 'vote';
              note = (d === false ? 'brak w słowniku' : 'do oceny') + (yes || no ? ` · 👍${yes} 👎${no}` : '');
            }
          }
        }
        const o = (R.ovr || {})[key];
        if (o === true || o === false) { ok = o; st = o ? 'ok' : 'bad'; note = o ? 'uznane przez gospodarza' : 'odrzucone przez gospodarza'; if (!txt) { ok = false; st = 'empty'; note = ''; } }
        out.cells[p][cat.id] = { txt, st, ok, note, pts: 0, key };
        if (ok) valid.push(p);
      }
      const groups = {};
      valid.forEach((p) => { const f = D.fold(out.cells[p][cat.id].txt); groups[f] = (groups[f] || 0) + 1; });
      valid.forEach((p) => {
        const c = out.cells[p][cat.id];
        if (valid.length === 1) c.pts = 15;
        else if (groups[D.fold(c.txt)] > 1) c.pts = 5;
        else c.pts = 10;
        out.totals[p] += c.pts;
      });
    }
    return out;
  }

  // ---------- sieć (MQTT) ----------
  class Net {
    constructor() { this.c = null; this.handlers = {}; this.connected = false; this.onStatus = null; }
    connect(bi, timeout = 7000) {
      return new Promise((resolve, reject) => {
        if (!window.mqtt) return reject(new Error('Brak biblioteki sieciowej'));
        let done = false;
        const c = window.mqtt.connect(BROKERS[bi], {
          clientId: 'pm_' + rid(10),
          keepalive: 30,
          reconnectPeriod: 2000,
          connectTimeout: timeout,
          clean: true,
        });
        const t = setTimeout(() => { if (!done) { done = true; try { c.end(true); } catch (e) {} reject(new Error('timeout')); } }, timeout + 500);
        c.on('connect', () => {
          this.connected = true;
          this.onStatus && this.onStatus(true);
          Object.keys(this.handlers).forEach((tp) => c.subscribe(tp, { qos: 0 }));
          if (!done) { done = true; clearTimeout(t); this.c = c; resolve(); }
          this.onReconnect && this.onReconnect();
        });
        c.on('close', () => { this.connected = false; this.onStatus && this.onStatus(false); });
        c.on('offline', () => { this.connected = false; this.onStatus && this.onStatus(false); });
        c.on('error', () => {});
        c.on('message', (topic, payload) => {
          const fn = this.handlers[topic];
          if (!fn) return;
          const s = payload.toString();
          if (!s) return fn(null);
          try { fn(JSON.parse(s)); } catch (e) {}
        });
      });
    }
    sub(topic, fn) { this.handlers[topic] = fn; if (this.c && this.connected) this.c.subscribe(topic, { qos: 0 }); }
    pub(topic, obj, retain = false) {
      if (!this.c) return;
      this.c.publish(topic, obj == null ? '' : JSON.stringify(obj), { qos: 0, retain });
    }
    close() { try { this.c && this.c.end(true); } catch (e) {} this.c = null; this.handlers = {}; this.connected = false; }
  }

  // ---------- stan aplikacji ----------
  let mode = 'home'; // home | online | offline
  let net = null;
  let G = null; // stan gry online (od gospodarza)
  let isHost = false;
  let code = null;
  let brokerIdx = 0;
  let hostAns = {}; // gospodarz: odpowiedzi graczy w bieżącej rundzie
  let finals = {}; // gospodarz: kto przysłał końcowe odpowiedzi
  let myAns = {}; // moje odpowiedzi w bieżącej rundzie
  let myRound = -1;
  let localStart = 0, localEnd = null; // czas lokalny (klient)
  let lastStateAt = 0;
  let spinTimer = null, spinLetter = 'A', spinIdx = 0;
  let screenKey = '';
  let iDone = false;
  let netOn = false;

  // ---------- render ----------
  const app = $('#app');
  function render(force) {
    const key = screenKeyNow();
    if (!force && key === screenKey && partialUpdate()) return;
    screenKey = key;
    const act = document.activeElement;
    const focusId = act && act.id ? act.id : null;
    const sel = focusId && act.selectionStart != null ? [act.selectionStart, act.selectionEnd] : null;
    app.innerHTML = '';
    let view;
    if (mode === 'home') view = viewHome();
    else if (mode === 'online') view = viewOnline();
    else view = viewOffline();
    app.appendChild(view);
    if (focusId) {
      const el = document.getElementById(focusId);
      if (el) { el.focus(); if (sel && el.setSelectionRange) try { el.setSelectionRange(sel[0], sel[1]); } catch (e) {} }
    }
    tick();
  }
  function screenKeyNow() {
    if (mode === 'online' && G) {
      if (G.phase === 'play' || G.phase === 'stopping' || G.phase === 'collect') return 'on-play-' + G.round + '-' + iDone;
      if (G.phase === 'spin') return 'on-spin-' + G.round + '-' + isHost;
    }
    if (mode === 'offline' && O && O.phase === 'play') return 'off-play-' + O.round + '-' + O.turn;
    return 'x' + Math.random();
  }
  function partialUpdate() {
    // aktualizacja bez przebudowy ekranu (zachowuje fokus i treść pól)
    if (mode === 'online' && G && (G.phase === 'play' || G.phase === 'stopping' || G.phase === 'collect')) {
      const st = $('#playStatus');
      if (st) st.replaceWith(playStatus());
      const ov = $('#stopOverlay');
      if (G.phase !== 'play' && !ov) app.appendChild(stopOverlay());
      else if (ov) ov.replaceWith(stopOverlay());
      return true;
    }
    if (mode === 'online' && G && G.phase === 'spin') return true;
    if (mode === 'offline' && O && O.phase === 'play') return true;
    return false;
  }

  function header(right) {
    return h('div', { class: 'row', style: 'justify-content:space-between;flex-wrap:nowrap;margin-bottom:6px' },
      h('button', { class: 'ghost', style: 'flex:0 0 auto;padding:8px 12px', onclick: leaveConfirm }, '← Menu'),
      right || h('span'));
  }
  function netBadge() { return h('span', { class: 'net ' + (netOn ? 'on' : 'off'), id: 'netBadge' }, netOn ? '● online' : '● łączenie…'); }

  // ---------- ekran startowy ----------
  let deferredInstall = null;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstall = e; if (mode === 'home') render(true); });
  const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent);

  function viewHome() {
    const params = new URLSearchParams(location.search);
    const linkCode = (params.get('g') || '').toUpperCase();
    const savedHost = store.get('hostGame');
    const lastJoin = store.get('lastJoin');
    const wrap = h('div', null,
      h('div', { class: 'logo' }, h('div', { class: 'big' }, 'Państwa Miasta'), h('div', { class: 'sub' }, 'gra słowna dla całej ekipy')),
      h('div', { class: 'card' },
        h('label', { class: 'lbl', for: 'nm' }, 'Twoje imię lub ksywka'),
        h('input', { id: 'nm', maxlength: 18, placeholder: 'np. Sebastian', value: me.name, oninput: (e) => { me.name = e.target.value.trim(); store.set('name', me.name); } })),
      linkCode ? h('div', { class: 'card' },
        h('h2', null, 'Zaproszenie do gry'),
        h('div', { class: 'code' }, linkCode),
        h('button', { class: 'primary wide huge', onclick: () => joinGame(linkCode, +(params.get('b') || linkCode.slice(-1)) || 0) }, 'Dołącz do gry')) : null,
      h('div', { class: 'card col' },
        h('h2', null, 'Gra online'),
        h('button', { class: 'primary wide huge', onclick: createGame }, '➕ Nowa gra'),
        h('div', { class: 'row' },
          h('input', { id: 'jc', placeholder: 'KOD GRY', maxlength: 6, style: 'text-transform:uppercase;letter-spacing:3px;font-weight:800', value: '' }),
          h('button', { style: 'flex:0 0 auto', onclick: () => { const c = ($('#jc').value || '').trim().toUpperCase(); if (c.length < 5) return toast('Wpisz 5-znakowy kod'); joinGame(c, +c.slice(-1) || 0); } }, 'Dołącz')),
        savedHost && Date.now() - savedHost.at < 12 * 3600e3 ? h('button', { class: 'wide', onclick: () => resumeHost(savedHost) }, '↩ Wróć do swojej gry ' + savedHost.code) : null,
        lastJoin && Date.now() - lastJoin.at < 6 * 3600e3 && !linkCode ? h('button', { class: 'wide ghost', onclick: () => joinGame(lastJoin.code, lastJoin.b) }, '↩ Wróć do gry ' + lastJoin.code) : null),
      h('div', { class: 'card col' },
        h('h2', null, 'Gra offline'),
        h('div', { class: 'muted small' }, 'Bez internetu, na jednym telefonie: odpowiedzi wpisuje każdy po kolei albo gracie na kartkach, a aplikacja losuje literę i mierzy czas.'),
        h('button', { class: 'wide huge', onclick: startOffline }, '📴 Graj offline')),
      h('div', { class: 'card col' },
        h('div', { class: 'row' },
          h('button', { onclick: () => { store.set('theme', store.get('theme', 'dark') === 'dark' ? 'light' : 'dark'); applyTheme(); } }, '🌓 Motyw: ciemny / sepia'),
          !isStandalone() ? h('button', { onclick: installApp }, '📲 Dodaj na pulpit') : null),
        h('details', null, h('summary', null, 'Zasady punktacji'),
          h('div', { class: 'small muted' },
            h('p', null, '15 pkt: jako jedyny masz poprawną odpowiedź w kategorii. 10 pkt: poprawna, inna niż pozostałych. 5 pkt: taka sama jak u kogoś. 0 pkt: brak, zła litera albo odrzucona.'),
            h('p', null, 'Odpowiedzi ze słownika (państwa, miasta, kolory, imiona, zwierzęta i inne) zalicza się od razu. Pozostałe zalicza się, chyba że więcej graczy kliknie 👎 niż 👍. Gospodarz ma ostatnie słowo.'))),
        h('div', { class: 'small muted center' }, 'wersja ' + APP_VER)));
    return wrap;
  }

  async function installApp() {
    if (deferredInstall) { deferredInstall.prompt(); deferredInstall = null; return; }
    if (isIOS()) return alert('iPhone: otwórz tę stronę w Safari, stuknij ikonę „Udostępnij” (kwadrat ze strzałką), potem „Do ekranu początkowego”.');
    alert('Otwórz menu przeglądarki (⋮) i wybierz „Dodaj do ekranu głównego” albo „Zainstaluj aplikację”.');
  }
  function needName() {
    if (me.name) return false;
    toast('Najpierw wpisz swoje imię');
    const i = $('#nm'); i && i.focus();
    return true;
  }
  function leaveConfirm() {
    if (mode === 'online' && G && G.phase !== 'final' && !confirm(isHost ? 'Wyjść do menu? Gra zostanie wstrzymana, wrócisz do niej przyciskiem na ekranie startowym.' : 'Wyjść z gry?')) return;
    if (mode === 'offline' && O && O.phase !== 'lobby' && !confirm('Wyjść do menu? Wynik gry offline zostanie zapamiętany.')) return;
    goHome();
  }
  function goHome() {
    if (net) { if (!isHost && code) net.pub(TOPIC(code) + '/h', { t: 'leave', id: me.id }); net.close(); net = null; }
    clearInterval(hostLoop); hostLoop = null;
    mode = 'home'; G = null; isHost = false; code = null;
    keepAwake(false);
    history.replaceState(null, '', location.pathname);
    render(true);
  }

  // ---------- gospodarz ----------
  let hostLoop = null;
  async function createGame() {
    if (needName()) return;
    toast('Tworzę grę…', 8000);
    for (let i = 0; i < BROKERS.length; i++) {
      try {
        net = new Net();
        await net.connect(i, 6000);
        brokerIdx = i;
        code = makeCode(i);
        G = {
          v: 1, code, hostId: me.id, phase: 'lobby', round: 0, letter: null, usedLetters: [],
          players: [{ id: me.id, name: me.name, score: 0, online: true }],
          settings: Object.assign(defaultSettings(), store.get('lastSettings', {})),
          done: [], history: [], R: null,
        };
        startHost();
        toast('Gra utworzona: ' + code);
        return;
      } catch (e) { net && net.close(); net = null; }
    }
    toast('Nie udało się połączyć z serwerem gry. Sprawdź internet albo zagraj offline.', 4000);
  }
  function resumeHost(saved) {
    if (needName()) return;
    brokerIdx = saved.b; code = saved.code; G = saved.G;
    G.players.forEach((p) => { if (p.id !== me.id) p.online = false; });
    hostAns = saved.hostAns || {};
    net = new Net();
    toast('Łączę…', 6000);
    net.connect(brokerIdx, 7000).then(() => startHost()).catch(() => { toast('Brak połączenia z serwerem gry.'); net.close(); net = null; });
  }
  function startHost() {
    isHost = true; mode = 'online';
    lastSeen[me.id] = Date.now();
    net.onStatus = (on) => { netOn = on; const b = $('#netBadge'); if (b) b.replaceWith(netBadge()); };
    netOn = true;
    net.onReconnect = () => publish();
    net.sub(TOPIC(code) + '/h', (m) => m && hostMsg(m));
    history.replaceState(null, '', location.pathname + '?g=' + code + '&b=' + brokerIdx);
    publish();
    clearInterval(hostLoop);
    hostLoop = setInterval(hostTick, 500);
    render(true);
  }
  const lastSeen = {};
  let lastPub = 0;
  function publish() {
    if (!isHost || !G) return;
    const now = Date.now();
    const snap = Object.assign({}, G, {
      sentAt: now,
      remainingMs: G.endAt ? Math.max(0, G.endAt - now) : null,
      startInMs: G.startAt ? Math.max(0, G.startAt - now) : 0,
    });
    delete snap.endAt; delete snap.startAt;
    net && net.pub(TOPIC(code) + '/s', snap, true);
    lastPub = now;
    store.set('hostGame', { code, b: brokerIdx, G, hostAns, at: now });
    onState(snap, true);
  }
  function hostTick() {
    if (!G) return;
    const now = Date.now();
    lastSeen[me.id] = now;
    let changed = false;
    G.players.forEach((p) => {
      const on = now - (lastSeen[p.id] || 0) < 16000;
      if (p.online !== on) { p.online = on; changed = true; }
    });
    if (G.phase === 'play' && G.endAt && now >= G.endAt) return startCollect();
    if (G.phase === 'stopping' && now >= G.endAt) return startCollect();
    if (G.phase === 'collect') {
      const need = G.players.filter((p) => p.online).map((p) => p.id);
      if (now >= G.collectUntil || need.every((id) => finals[id])) return finishRound();
    }
    if (G.phase === 'play' && G.settings.endMode === 'all') {
      const need = G.players.filter((p) => p.online).map((p) => p.id);
      if (need.length && need.every((id) => G.done.includes(id))) return startCollect();
    }
    if (changed || now - lastPub > 4000) publish();
  }
  function hostMsg(m) {
    if (!m || !m.id || !G) return;
    lastSeen[m.id] = Date.now();
    let p = G.players.find((x) => x.id === m.id);
    switch (m.t) {
      case 'join':
        if (!p) {
          if (G.players.length >= 20) return;
          G.players.push({ id: m.id, name: String(m.name || 'Gracz').slice(0, 18), score: 0, online: true });
        } else { p.name = String(m.name || p.name).slice(0, 18); p.online = true; p.left = false; }
        publish();
        break;
      case 'hb':
        if (p && !p.online) { p.online = true; publish(); }
        break;
      case 'leave':
        if (p) { p.online = false; lastSeen[m.id] = 0; publish(); }
        break;
      case 'ans':
        if (!p || m.round !== G.round) return;
        if (!['play', 'stopping', 'collect'].includes(G.phase)) return;
        hostAns[m.id] = sanitizeAns(m.answers);
        if (m.final) finals[m.id] = true;
        break;
      case 'done':
        if (!p || m.round !== G.round || G.phase !== 'play') return;
        if (m.answers) hostAns[m.id] = sanitizeAns(m.answers);
        if (G.settings.endMode === 'first') startStopping(m.id);
        else { if (!G.done.includes(m.id)) G.done.push(m.id); finals[m.id] = true; publish(); }
        break;
      case 'vote':
        if (!p || G.phase !== 'review' || !G.R) return;
        G.R.votes[m.key] = G.R.votes[m.key] || {};
        G.R.votes[m.key][m.id] = m.v;
        publish();
        break;
    }
  }
  function sanitizeAns(a) {
    const o = {};
    if (a && typeof a === 'object') for (const k in a) o[k] = String(a[k] || '').slice(0, 40);
    return o;
  }
  function hostSpinStart() {
    if (G.phase !== 'lobby' && G.phase !== 'spin') return;
    if (!G.settings.cats.length) return toast('Wybierz przynajmniej jedną kategorię');
    G.phase = 'spin';
    publish();
    localSpinStart();
  }
  function hostSpinStop() {
    localSpinStop();
    const now = Date.now();
    G.letter = spinLetter;
    G.round += 1;
    G.phase = 'play';
    G.startAt = now + 3000;
    G.endAt = G.settings.time ? G.startAt + G.settings.time * 1000 : null;
    G.done = []; G.stopBy = null; G.R = null;
    G.roundCats = G.settings.cats.map((id) => catById(G.settings, id)).filter(Boolean).map((c) => ({ id: c.id, name: c.name, icon: c.icon }));
    hostAns = {}; finals = {};
    store.set('lastSettings', G.settings);
    publish();
  }
  function startStopping(by) {
    if (G.phase !== 'play') return;
    G.phase = 'stopping'; G.stopBy = by; G.endAt = Date.now() + 3000;
    publish();
  }
  function startCollect() {
    if (G.phase !== 'play' && G.phase !== 'stopping') return;
    G.phase = 'collect'; G.endAt = null; G.collectUntil = Date.now() + 3000;
    // gospodarz wysyła swoje odpowiedzi od razu
    hostAns[me.id] = sanitizeAns(myAns); finals[me.id] = true;
    publish();
  }
  function finishRound() {
    if (G.phase !== 'collect') return;
    const ans = {};
    G.players.forEach((p) => { if (hostAns[p.id] || p.online) ans[p.id] = hostAns[p.id] || {}; });
    G.R = { cats: G.roundCats, letter: G.letter, ans, votes: {}, ovr: {} };
    G.phase = 'review';
    publish();
  }
  function hostOverride(key) {
    const cur = G.R.ovr[key];
    G.R.ovr[key] = cur === undefined ? true : cur === true ? false : undefined;
    if (G.R.ovr[key] === undefined) delete G.R.ovr[key];
    publish();
  }
  function hostCommitRound(toFinal) {
    const sc = scoreRound(G.R, G.settings);
    G.players.forEach((p) => { p.score += sc.totals[p.id] || 0; });
    G.history.push({ round: G.round, letter: G.letter, pts: sc.totals });
    if (!G.usedLetters.includes(G.letter)) G.usedLetters.push(G.letter);
    G.R = null;
    G.phase = toFinal ? 'final' : 'lobby';
    publish();
  }
  function hostNewGame() {
    G.players.forEach((p) => (p.score = 0));
    G.history = []; G.usedLetters = []; G.round = 0; G.phase = 'lobby';
    publish();
  }

  // ---------- klient ----------
  let clientHb = null;
  async function joinGame(c, bi) {
    if (needName()) return;
    code = c.toUpperCase(); brokerIdx = Math.min(Math.max(bi | 0, 0), BROKERS.length - 1);
    isHost = false; G = null; mode = 'online';
    render(true);
    net = new Net();
    net.onStatus = (on) => { netOn = on; const b = $('#netBadge'); if (b) b.replaceWith(netBadge()); };
    try { await net.connect(brokerIdx, 8000); }
    catch (e) { toast('Nie udało się połączyć. Sprawdź internet.', 3500); net.close(); net = null; mode = 'home'; render(true); return; }
    netOn = true;
    store.set('lastJoin', { code, b: brokerIdx, at: Date.now() });
    history.replaceState(null, '', location.pathname + '?g=' + code + '&b=' + brokerIdx);
    net.sub(TOPIC(code) + '/s', (s) => {
      if (!s) { if (G) { toast('Gospodarz zakończył grę.'); } return; }
      onState(s, false);
    });
    const hello = () => net.pub(TOPIC(code) + '/h', { t: 'join', id: me.id, name: me.name });
    net.onReconnect = hello;
    hello();
    clearInterval(clientHb);
    clientHb = setInterval(() => {
      if (mode !== 'online' || isHost || !net) return clearInterval(clientHb);
      net.pub(TOPIC(code) + '/h', { t: 'hb', id: me.id });
      if (G && ['play', 'stopping'].includes(G.phase) && myRound === G.round) sendAns(false);
      render(false);
    }, 3000);
    setTimeout(() => { if (mode === 'online' && !G && !isHost) { toast('Nie znaleziono gry o kodzie ' + code + '. Sprawdź kod.', 4000); } }, 7000);
  }
  function sendAns(final) {
    if (!net || !G) return;
    if (isHost) { hostAns[me.id] = sanitizeAns(myAns); if (final) finals[me.id] = true; return; }
    net.pub(TOPIC(code) + '/h', { t: 'ans', id: me.id, round: G.round, answers: myAns, final });
  }

  function onState(s, fromSelf) {
    const prev = G;
    if (!fromSelf) G = s;
    lastStateAt = Date.now();
    const recv = performance.now();
    if (s.phase === 'play' || s.phase === 'stopping') {
      localStart = recv + (s.startInMs || 0);
      localEnd = s.remainingMs == null ? null : recv + s.remainingMs;
    } else localEnd = null;
    if (s.round !== myRound && (s.phase === 'play')) { myRound = s.round; myAns = {}; iDone = false; }
    if (!isHost && s.phase === 'spin' && !spinTimer) localSpinStart();
    if (!isHost && s.phase !== 'spin' && spinTimer) localSpinStop();
    if (!isHost && (s.phase === 'stopping' || s.phase === 'collect') && prev && prev.phase === 'play') { sendAns(true); vibrate([80, 60, 80]); }
    if (s.phase === 'play' && prev && prev.phase !== 'play') vibrate(60);
    keepAwake(['spin', 'play', 'stopping'].includes(s.phase));
    if (!isHost && G && !G.players.find((p) => p.id === me.id) && net) net.pub(TOPIC(code) + '/h', { t: 'join', id: me.id, name: me.name });
    render(false);
  }

  // ---------- losowanie litery ----------
  function localSpinStart() {
    if (spinTimer) return;
    const pool = isHost ? letterPool(G.settings, G.usedLetters) : (BASE_LETTERS + PL_LETTERS).split('');
    const startAt = pool.indexOf('A');
    spinIdx = startAt >= 0 ? startAt : 0;
    spinLetter = pool[spinIdx];
    spinTimer = setInterval(() => {
      spinIdx = (spinIdx + 1) % pool.length;
      spinLetter = pool[spinIdx];
      const el = $('#spinL'); if (el) el.textContent = spinLetter;
    }, 45);
    const box = $('#spinBox'); if (box) box.classList.add('spinning');
  }
  function localSpinStop() { clearInterval(spinTimer); spinTimer = null; }

  function spinBox(onTap, idleText) {
    const spinning = !!spinTimer;
    return h('div', { id: 'spinBox', class: 'spinbox' + (spinning ? ' spinning' : ''), onpointerdown: (e) => { e.preventDefault(); onTap && onTap(); } },
      h('div', { class: 'L', id: 'spinL' }, spinning ? spinLetter : 'A'),
      h('div', { class: 'hint' }, spinning ? (onTap ? 'Uderz, aby zatrzymać' : 'Losowanie…') : idleText));
  }

  // ---------- widoki online ----------
  function viewOnline() {
    if (!G) return h('div', null, header(netBadge()), h('div', { class: 'card center' }, h('h2', null, 'Łączę z grą ' + (code || '') + '…'), h('div', { class: 'muted' }, 'Jeśli to trwa długo, sprawdź kod i internet.')));
    switch (G.phase) {
      case 'lobby': return viewLobby();
      case 'spin': return viewSpin();
      case 'play': case 'stopping': case 'collect': return viewPlay();
      case 'review': return viewReview();
      case 'final': return viewFinal();
    }
    return h('div');
  }
  function shareLink() { return location.origin + location.pathname + '?g=' + code + '&b=' + brokerIdx; }
  async function doShare() {
    const url = shareLink();
    const text = `Zagraj ze mną w Państwa Miasta! Kod gry: ${code}`;
    if (navigator.share) { try { await navigator.share({ title: 'Państwa Miasta', text, url }); return; } catch (e) { if (e && e.name === 'AbortError') return; } }
    try { await navigator.clipboard.writeText(text + ' ' + url); toast('Link skopiowany'); } catch (e) { prompt('Skopiuj link:', url); }
  }
  function qrSvg(text) {
    try { const q = window.qrcode(0, 'M'); q.addData(text); q.make(); return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true }); } catch (e) { return ''; }
  }
  function playersList(showScore, removable) {
    const sorted = showScore ? [...G.players].sort((a, b) => b.score - a.score) : G.players;
    return h('div', { class: 'players' }, sorted.map((p) =>
      h('div', { class: 'player' },
        h('span', null, h('span', { class: 'dot' + (p.online ? '' : ' off') }), p.name, p.id === me.id ? h('span', { class: 'badge' }, 'Ty') : null, p.id === G.hostId ? h('span', { class: 'badge' }, 'gospodarz') : null),
        h('span', { class: 'row', style: 'flex:0 0 auto;gap:8px' },
          showScore ? h('b', null, p.score + ' pkt') : null,
          removable && p.id !== me.id ? h('button', { class: 'ghost', style: 'padding:4px 10px', onclick: () => { if (confirm('Usunąć gracza ' + p.name + '?')) { G.players = G.players.filter((x) => x.id !== p.id); publish(); } } }, '✕') : null))));
  }
  function settingsEditor(S, onChange, editable) {
    const chips = h('div', { class: 'chips' }, allCats(S).map((c) => {
      const on = S.cats.includes(c.id);
      return h('button', { class: 'chip' + (on ? ' on' : ''), disabled: !editable, onclick: () => {
        S.cats = on ? S.cats.filter((x) => x !== c.id) : S.cats.concat(c.id);
        onChange();
      } }, c.icon + ' ' + c.name,
      c.id.startsWith('c_') && editable ? h('span', { class: 'x', onclick: (e) => { e.stopPropagation(); S.custom = S.custom.filter((x) => x.id !== c.id); S.cats = S.cats.filter((x) => x !== c.id); onChange(); } }, '✕') : null);
    }));
    const timeSeg = h('div', { class: 'seg' }, TIMES.map((t) => h('button', { class: S.time === t ? 'on' : '', disabled: !editable, onclick: () => { S.time = t; onChange(); } }, t ? (t <= 90 ? t + ' s' : t / 60 + ' min') : 'bez limitu')));
    const card = h('div', { class: 'card' },
      h('h2', null, 'Kategorie w tej rundzie'),
      h('div', { class: 'muted small', style: 'margin-bottom:8px' }, editable ? 'Dotknij, aby włączyć lub wyłączyć. Wybrano: ' + S.cats.length : 'Ustawia gospodarz. Wybrano: ' + S.cats.length),
      chips,
      editable ? h('div', { class: 'row', style: 'margin-top:10px' },
        h('input', { id: 'newCat', placeholder: 'Własna kategoria, np. Piłkarz', maxlength: 24 }),
        h('button', { style: 'flex:0 0 auto', onclick: () => {
          const v = ($('#newCat').value || '').trim();
          if (!v) return;
          const id = 'c_' + rid(5);
          S.custom = (S.custom || []).concat({ id, name: v });
          S.cats = S.cats.concat(id);
          $('#newCat').value = '';
          onChange();
        } }, 'Dodaj')) : null,
      editable ? h('div', { class: 'row', style: 'margin-top:8px' },
        h('button', { onclick: () => { const ids = allCats(S).map((c) => c.id).sort(() => Math.random() - 0.5); S.cats = ids.slice(0, 6); onChange(); } }, '🎲 Losowe 6'),
        h('button', { onclick: () => { S.cats = defaultSettings().cats; onChange(); } }, 'Klasyczne'),
        h('button', { onclick: () => { S.cats = []; onChange(); } }, 'Wyczyść')) : null,
      h('h3', { style: 'margin-top:16px' }, 'Czas na odpowiedzi'),
      timeSeg,
      h('h3', { style: 'margin-top:16px' }, 'Kiedy kończy się runda'),
      h('div', { class: 'seg' },
        h('button', { class: S.endMode === 'first' ? 'on' : '', disabled: !editable, onclick: () => { S.endMode = 'first'; onChange(); } }, 'Pierwszy „Zakończ” (+3 s)'),
        h('button', { class: S.endMode === 'all' ? 'on' : '', disabled: !editable, onclick: () => { S.endMode = 'all'; onChange(); } }, 'Gdy wszyscy klikną')),
      h('h3', { style: 'margin-top:16px' }, 'Litery'),
      h('div', { class: 'seg' },
        h('button', { class: S.plLetters ? 'on' : '', disabled: !editable, onclick: () => { S.plLetters = !S.plLetters; onChange(); } }, (S.plLetters ? '✓ ' : '') + 'Także Ł Ś Ż'),
        h('button', { class: S.noRepeat ? 'on' : '', disabled: !editable, onclick: () => { S.noRepeat = !S.noRepeat; onChange(); } }, (S.noRepeat ? '✓ ' : '') + 'Bez powtórek'),
        h('button', { class: S.foldLetters ? 'on' : '', disabled: !editable, onclick: () => { S.foldLetters = !S.foldLetters; onChange(); } }, (S.foldLetters ? '✓ ' : '') + 'S = Ś, Z = Ż')));
    return card;
  }
  function viewLobby() {
    const url = shareLink();
    return h('div', null,
      header(netBadge()),
      h('div', { class: 'card center' },
        h('div', { class: 'muted' }, 'Kod gry'),
        h('div', { class: 'code' }, code),
        isHost ? h('div', null,
          G.round ? null : h('div', { class: 'qr', html: qrSvg(url) }),
          h('button', { class: 'primary wide', onclick: doShare }, '📤 Wyślij zaproszenie (link)'),
          h('div', { class: 'small muted', style: 'margin-top:8px' }, 'Inni mogą też wpisać kod na ekranie startowym albo zeskanować kod QR.')) : h('div', { class: 'muted small' }, 'Czekamy, aż gospodarz wylosuje literę.')),
      h('div', { class: 'card' }, h('h2', null, 'Gracze (' + G.players.length + ')'), playersList(G.round > 0, isHost)),
      settingsEditor(G.settings, () => publish(), isHost),
      isHost ? h('div', { class: 'card center' },
        h('h2', null, G.round ? 'Runda ' + (G.round + 1) : 'Pierwsza runda'),
        spinBox(hostSpinStart, 'Uderz, aby losować literę'),
        G.usedLetters.length ? h('div', { class: 'small muted' }, 'Były już: ' + G.usedLetters.join(' ')) : null,
        G.round ? h('button', { class: 'wide', style: 'margin-top:10px', onclick: () => { if (confirm('Zakończyć grę i pokazać wyniki?')) { G.phase = 'final'; publish(); } } }, '🏁 Zakończ grę') : null) : null);
  }
  function viewSpin() {
    return h('div', null, header(netBadge()),
      h('div', { class: 'card center' },
        h('h2', null, 'Losowanie litery'),
        spinBox(isHost ? hostSpinStop : null, isHost ? 'Uderz, aby zatrzymać' : 'Losowanie…'),
        h('div', { class: 'muted' }, isHost ? 'Uderz jeszcze raz w okienko, żeby zatrzymać literę.' : 'Gospodarz losuje literę…')));
  }
  function viewPlay() {
    const cats = G.roundCats || [];
    const locked = iDone || G.phase !== 'play';
    const fields = cats.map((c, i) => h('div', { class: 'field' },
      h('label', { for: 'f_' + c.id }, c.icon, ' ', c.name),
      h('input', {
        id: 'f_' + c.id, value: myAns[c.id] || '', autocomplete: 'off', autocapitalize: 'words', spellcheck: 'false', maxlength: 40,
        placeholder: G.letter + '…', disabled: locked,
        enterkeyhint: i === cats.length - 1 ? 'done' : 'next',
        oninput: (e) => { myAns[c.id] = e.target.value; },
        onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); const n = $('#f_' + (cats[i + 1] || {}).id); n ? n.focus() : e.target.blur(); } },
      })));
    const doneBtn = h('button', { class: 'danger wide huge', disabled: locked, onclick: () => {
      if (!confirm('Na pewno kończysz?')) return;
      iDone = true;
      if (isHost) { hostAns[me.id] = sanitizeAns(myAns); hostMsg({ t: 'done', id: me.id, round: G.round, answers: myAns }); }
      else { net.pub(TOPIC(code) + '/h', { t: 'done', id: me.id, round: G.round, answers: myAns }); sendAns(true); }
      render(true);
    } }, iDone ? 'Wysłano ✓' : '✋ Zakończ');
    const wrap = h('div', null,
      h('div', { class: 'topbar' },
        h('div', { class: 'letterBadge' }, G.letter),
        h('div', { class: 'timer', id: 'timer' }, '…'),
        h('button', { class: 'ghost', style: 'padding:8px 10px', onclick: leaveConfirm }, '☰')),
      playStatus(),
      h('div', { class: 'card' }, fields),
      h('div', { class: 'bottombar' }, h('div', { class: 'inner' }, doneBtn)));
    const ov = (G.phase !== 'play') ? stopOverlay() : null;
    if (ov) wrap.appendChild(ov);
    wrap.appendChild(startOverlay());
    return wrap;
  }
  function playStatus() {
    let txt = '';
    if (G.settings.endMode === 'all') {
      const on = G.players.filter((p) => p.online);
      txt = 'Skończyli: ' + G.done.length + ' z ' + on.length + (iDone ? ' · czekamy na resztę' : '');
    } else txt = 'Kto pierwszy kliknie „Zakończ”, zatrzymuje rundę (3 s na dokończenie).';
    return h('div', { id: 'playStatus', class: 'small muted center' }, txt);
  }
  function stopOverlay() {
    if (G.phase === 'play') return h('div', { id: 'stopOverlay', style: 'display:none' });
    const by = G.players.find((p) => p.id === G.stopBy);
    return h('div', { id: 'stopOverlay', class: 'overlay', style: G.phase === 'stopping' ? 'background:transparent;backdrop-filter:none;pointer-events:none;inset:auto 0 90px 0;' : '' },
      G.phase === 'stopping'
        ? h('div', { class: 'card', style: 'border-color:var(--accent2)' }, h('div', { class: 'msg' }, '✋ STOP! ' + (by ? by.name : '')), h('div', { class: 'muted' }, 'Dokończ wpisywanie…'))
        : h('div', null, h('div', { class: 'msg' }, 'Sprawdzam odpowiedzi…'), h('div', { class: 'muted' }, 'Zbieram odpowiedzi od wszystkich graczy')));
  }
  function startOverlay() {
    return h('div', { id: 'startOverlay', class: 'overlay', style: 'display:none' },
      h('div', { class: 'muted msg' }, 'Litera'), h('div', { class: 'bigL' }, G.letter), h('div', { class: 'msg', id: 'startCount' }, ''));
  }

  function reviewBlock(R, S, players, opt) {
    const sc = scoreRound(R, S);
    const name = (id) => (players.find((p) => p.id === id) || {}).name || '?';
    const blocks = R.cats.map((c) => h('div', { class: 'card rcat' },
      h('h2', null, c.icon + ' ' + c.name),
      Object.keys(R.ans).map((pid) => {
        const cell = sc.cells[pid][c.id];
        const myVote = ((R.votes || {})[cell.key] || {})[opt.myId];
        const stTxt = { ok: '✓', vote: '?', bad: '✗', empty: '–' }[cell.st];
        return h('div', { class: 'ans ' + (cell.ok ? 'ok' : cell.txt ? 'bad' : '') },
          h('div', { style: 'flex:1;min-width:0' },
            h('div', { class: 'who' }, name(pid), cell.note ? h('span', { class: 'st ' + (cell.st === 'empty' ? 'bad' : cell.st) }, stTxt + ' ' + cell.note) : null),
            h('div', { class: 'txt' }, cell.txt || '—')),
          cell.txt && opt.canVote && pid !== opt.myId && cell.st === 'vote' && (R.ovr || {})[cell.key] === undefined ? h('div', { class: 'votes' },
            h('button', { class: myVote > 0 ? 'on' : '', onclick: () => opt.onVote(cell.key, myVote > 0 ? 0 : 1) }, '👍'),
            h('button', { class: myVote < 0 ? 'on' : '', onclick: () => opt.onVote(cell.key, myVote < 0 ? 0 : -1) }, '👎')) : null,
          cell.txt && opt.canOverride ? h('button', { class: 'ghost', style: 'padding:6px 8px;flex:0 0 auto', title: 'Uznaj / odrzuć', onclick: () => opt.onOverride(cell.key) }, (R.ovr || {})[cell.key] === true ? '✅' : (R.ovr || {})[cell.key] === false ? '⛔' : '⚖️') : null,
          h('div', { class: 'pts' }, cell.pts));
      })));
    const totals = h('div', { class: 'card' }, h('h2', null, 'Punkty w tej rundzie'),
      h('table', { class: 'score' }, Object.keys(R.ans).sort((a, b) => sc.totals[b] - sc.totals[a]).map((pid) =>
        h('tr', null, h('td', null, name(pid)), h('td', { class: 'n' }, '+' + sc.totals[pid]),
          h('td', { class: 'n muted' }, ((players.find((p) => p.id === pid) || {}).score || 0) + sc.totals[pid] + ' razem')))));
    return h('div', null, totals, blocks);
  }
  function viewReview() {
    return h('div', null, header(netBadge()),
      h('div', { class: 'card center' }, h('div', { class: 'row', style: 'justify-content:center;flex-wrap:nowrap' }, h('div', { class: 'letterBadge', style: 'flex:0 0 auto' }, G.letter), h('h2', { style: 'flex:0 1 auto;margin:0' }, 'Runda ' + G.round + ': sprawdzanie')),
        h('div', { class: 'small muted', style: 'margin-top:8px' }, '✓ ze słownika · ? do oceny (👍/👎) · ✗ zła litera lub odrzucone' + (isHost ? ' · ⚖️ Twoja decyzja gospodarza' : ''))),
      reviewBlock(G.R, G.settings, G.players, {
        myId: me.id, canVote: true, canOverride: isHost,
        onVote: (key, v) => { if (isHost) hostMsg({ t: 'vote', id: me.id, key, v }); else { net.pub(TOPIC(code) + '/h', { t: 'vote', id: me.id, key, v }); G.R.votes[key] = G.R.votes[key] || {}; G.R.votes[key][me.id] = v; render(true); } },
        onOverride: hostOverride,
      }),
      isHost ? h('div', { class: 'bottombar' }, h('div', { class: 'inner' },
        h('button', { onclick: () => hostCommitRound(true) }, '🏁 Koniec gry'),
        h('button', { class: 'primary', onclick: () => hostCommitRound(false) }, 'Zapisz i dalej ➜')))
        : h('div', { class: 'center muted small' }, 'Gospodarz zatwierdzi punkty i rozpocznie kolejną rundę.'));
  }
  function standings(players, historyArr) {
    const sorted = [...players].sort((a, b) => b.score - a.score);
    const medals = ['🥇', '🥈', '🥉'];
    return h('div', null,
      h('table', { class: 'score' }, sorted.map((p, i) => h('tr', null,
        h('td', { class: 'medal' }, medals[i] || i + 1 + '.'), h('td', null, h('b', null, p.name)), h('td', { class: 'n' }, h('b', null, p.score + ' pkt'))))),
      historyArr && historyArr.length ? h('details', { style: 'margin-top:10px' }, h('summary', null, 'Historia rund'),
        h('table', { class: 'score small' },
          h('tr', null, h('th', null, 'Runda'), sorted.map((p) => h('th', { class: 'n' }, p.name))),
          historyArr.map((r) => h('tr', null, h('td', null, r.round + '. ' + r.letter), sorted.map((p) => h('td', { class: 'n' }, (r.pts || {})[p.id] || 0)))))) : null);
  }
  function viewFinal() {
    return h('div', null, header(netBadge()),
      h('div', { class: 'card center' }, h('div', { style: 'font-size:56px' }, '🏆'), h('h1', null, 'Koniec gry'), h('div', { class: 'muted' }, 'Rozegrane rundy: ' + G.history.length)),
      h('div', { class: 'card' }, standings(G.players, G.history)),
      isHost ? h('div', { class: 'card col' },
        h('button', { class: 'primary wide huge', onclick: hostNewGame }, '🔄 Nowa gra z tą samą ekipą'),
        h('button', { class: 'wide', onclick: () => { net && net.pub(TOPIC(code) + '/s', null, true); store.del('hostGame'); goHome(); } }, 'Zamknij grę')) : h('div', { class: 'center muted' }, 'Gospodarz może rozpocząć nową grę.'));
  }

  // ---------- zegar ----------
  function tick() {
    const tEl = $('#timer');
    const sOv = $('#startOverlay');
    const now = performance.now();
    if (mode === 'online' && G && (G.phase === 'play' || G.phase === 'stopping' || G.phase === 'collect')) {
      if (sOv) {
        const left = localStart - now;
        if (G.phase === 'play' && left > 0) { sOv.style.display = 'flex'; $('#startCount').textContent = 'Start za ' + Math.ceil(left / 1000); }
        else if (sOv.style.display !== 'none') { sOv.style.display = 'none'; const f = $('.field input:not([disabled])'); if (f && !iDone) f.focus(); }
      }
      if (tEl) {
        const rem = localEnd == null ? null : localEnd - now;
        tEl.textContent = G.phase === 'collect' ? '0:00' : (rem == null ? '∞' : fmt(rem));
        tEl.classList.toggle('low', rem != null && rem < 10000);
      }
    }
    if (mode === 'offline' && O && O.phase === 'play') offTick();
  }
  setInterval(tick, 200);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && mode === 'online' && G) { keepAwake(['spin', 'play', 'stopping'].includes(G.phase)); } });

  // ======================================================
  // ---------- tryb offline (jeden telefon) ----------
  // ======================================================
  let O = null;
  function startOffline() {
    O = store.get('offline') || null;
    if (!O) O = { phase: 'lobby', players: [], settings: Object.assign(defaultSettings(), store.get('lastSettings', {})), input: 'pass', round: 0, usedLetters: [], history: [] };
    if (!O.players.length && me.name) O.players.push({ id: 'p' + rid(4), name: me.name, score: 0 });
    mode = 'offline';
    render(true);
  }
  function saveO() { store.set('offline', O); }
  let offEnd = null, offStart = 0;
  function viewOffline() {
    const back = header(h('span', { class: 'net' }, '📴 offline'));
    switch (O.phase) {
      case 'lobby': return h('div', null, back,
        h('div', { class: 'card' }, h('h2', null, 'Gracze'),
          h('div', { class: 'players' }, O.players.map((p) => h('div', { class: 'player' }, h('span', null, p.name), h('span', { class: 'row', style: 'flex:0 0 auto' }, O.round ? h('b', null, p.score + ' pkt') : null, h('button', { class: 'ghost', style: 'padding:4px 10px', onclick: () => { O.players = O.players.filter((x) => x !== p); saveO(); render(true); } }, '✕'))))),
          h('div', { class: 'row', style: 'margin-top:8px' }, h('input', { id: 'offName', placeholder: 'Imię gracza', maxlength: 18, onkeydown: (e) => { if (e.key === 'Enter') addOffPlayer(); } }), h('button', { style: 'flex:0 0 auto', onclick: addOffPlayer }, 'Dodaj'))),
        h('div', { class: 'card' }, h('h2', null, 'Jak gracie?'),
          h('div', { class: 'seg' },
            h('button', { class: O.input === 'pass' ? 'on' : '', onclick: () => { O.input = 'pass'; saveO(); render(true); } }, '📱 Każdy wpisuje po kolei'),
            h('button', { class: O.input === 'paper' ? 'on' : '', onclick: () => { O.input = 'paper'; saveO(); render(true); } }, '📝 Na kartkach')),
          h('div', { class: 'small muted', style: 'margin-top:8px' }, O.input === 'pass' ? 'Telefon przechodzi z rąk do rąk. Każdy ma ten sam czas, odpowiedzi innych są ukryte, potem automatyczne sprawdzanie.' : 'Aplikacja losuje literę i mierzy czas, odpowiedzi piszecie na kartkach, a punkty wpisujecie na koniec rundy.')),
        settingsEditor(O.settings, () => { saveO(); render(true); }, true),
        h('div', { class: 'card center' },
          spinBox(() => { if (!O.players.length) return toast('Dodaj graczy'); if (!O.settings.cats.length) return toast('Wybierz kategorie'); O.phase = 'spin'; localSpinStartOff(); render(true); }, 'Uderz, aby losować literę'),
          O.usedLetters.length ? h('div', { class: 'small muted' }, 'Były już: ' + O.usedLetters.join(' ')) : null,
          O.round ? h('div', { class: 'row', style: 'margin-top:10px' },
            h('button', { onclick: () => { O.phase = 'final'; saveO(); render(true); } }, '🏁 Wyniki'),
            h('button', { onclick: () => { if (confirm('Wyzerować punkty i zacząć od nowa?')) { O.players.forEach((p) => (p.score = 0)); O.round = 0; O.usedLetters = []; O.history = []; saveO(); render(true); } } }, '🔄 Od nowa')) : null));
      case 'spin': return h('div', null, back, h('div', { class: 'card center' }, h('h2', null, 'Losowanie litery'), spinBox(offSpinStop, ''), h('div', { class: 'muted' }, 'Uderz jeszcze raz, żeby zatrzymać.')));
      case 'turn': {
        const p = O.players[O.turn];
        return h('div', null, back, h('div', { class: 'card passbox' },
          h('div', { class: 'letterBadge', style: 'margin:0 auto 14px' }, O.letter),
          h('div', { class: 'muted' }, 'Gracz ' + (O.turn + 1) + ' z ' + O.players.length),
          h('h1', null, '📱 ' + p.name),
          h('div', { class: 'muted', style: 'margin-bottom:16px' }, 'Weź telefon. Gdy klikniesz Start, ruszy czas.'),
          h('button', { class: 'primary wide huge', onclick: () => { O.phase = 'play'; offStart = performance.now() + 3000; offEnd = O.settings.time ? offStart + O.settings.time * 1000 : null; O.cur = {}; render(true); keepAwake(true); } }, '▶ Start')));
      }
      case 'play': return viewOffPlay();
      case 'review': return h('div', null, back,
        h('div', { class: 'card center' }, h('h2', null, 'Runda ' + O.round + ': litera ' + O.letter), h('div', { class: 'small muted' }, 'Słownikowe zaliczone od razu. Pozostałe są zaliczone, chyba że je odrzucicie: ⚖️ przełącza uznaj / odrzuć.')),
        reviewBlock(O.R, O.settings, O.players, { myId: null, canVote: false, canOverride: true, onVote() {}, onOverride: (k) => { const c = O.R.ovr[k]; if (c === undefined) O.R.ovr[k] = true; else if (c === true) O.R.ovr[k] = false; else delete O.R.ovr[k]; saveO(); render(true); } }),
        h('div', { class: 'bottombar' }, h('div', { class: 'inner' }, h('button', { class: 'primary', onclick: () => { const sc = scoreRound(O.R, O.settings); O.players.forEach((p) => (p.score += sc.totals[p.id] || 0)); O.history.push({ round: O.round, letter: O.letter, pts: sc.totals }); O.R = null; O.phase = 'lobby'; saveO(); render(true); } }, 'Zapisz i dalej ➜'))));
      case 'paperScore': return h('div', null, back,
        h('div', { class: 'card' }, h('h2', null, 'Punkty za rundę ' + O.round + ' (' + O.letter + ')'),
          h('div', { class: 'small muted', style: 'margin-bottom:8px' }, 'Wpisz sumę punktów każdego gracza z tej rundy.'),
          O.players.map((p) => h('div', { class: 'player' }, h('span', null, p.name), h('input', { class: 'num', id: 'ps_' + p.id, type: 'number', inputmode: 'numeric', min: 0, step: 5, value: '0' })))),
        h('div', { class: 'bottombar' }, h('div', { class: 'inner' }, h('button', { class: 'primary', onclick: () => { const pts = {}; O.players.forEach((p) => { const v = parseInt($('#ps_' + p.id).value, 10) || 0; pts[p.id] = v; p.score += v; }); O.history.push({ round: O.round, letter: O.letter, pts }); O.phase = 'lobby'; saveO(); render(true); } }, 'Zapisz ➜'))));
      case 'final': return h('div', null, back,
        h('div', { class: 'card center' }, h('div', { style: 'font-size:56px' }, '🏆'), h('h1', null, 'Wyniki')),
        h('div', { class: 'card' }, standings(O.players, O.history)),
        h('div', { class: 'card col' },
          h('button', { class: 'primary wide', onclick: () => { O.phase = 'lobby'; saveO(); render(true); } }, '↩ Gramy dalej'),
          h('button', { class: 'wide', onclick: () => { O.players.forEach((p) => (p.score = 0)); O.round = 0; O.usedLetters = []; O.history = []; O.phase = 'lobby'; saveO(); render(true); } }, '🔄 Nowa gra')));
    }
    return h('div');
  }
  function addOffPlayer() {
    const v = ($('#offName').value || '').trim();
    if (!v) return;
    if (O.players.length >= 12) return toast('Maksymalnie 12 graczy');
    O.players.push({ id: 'p' + rid(4), name: v.slice(0, 18), score: 0 });
    saveO(); render(true);
    const i = $('#offName'); i && i.focus();
  }
  function localSpinStartOff() {
    const pool = letterPool(O.settings, O.usedLetters);
    spinIdx = Math.max(0, pool.indexOf('A')); spinLetter = pool[spinIdx];
    clearInterval(spinTimer);
    spinTimer = setInterval(() => { spinIdx = (spinIdx + 1) % pool.length; spinLetter = pool[spinIdx]; const el = $('#spinL'); if (el) el.textContent = spinLetter; }, 45);
  }
  function offSpinStop() {
    localSpinStop();
    O.letter = spinLetter; O.round += 1;
    if (!O.usedLetters.includes(O.letter)) O.usedLetters.push(O.letter);
    O.roundCats = O.settings.cats.map((id) => catById(O.settings, id)).filter(Boolean).map((c) => ({ id: c.id, name: c.name, icon: c.icon }));
    O.ans = {};
    store.set('lastSettings', O.settings);
    vibrate(60);
    if (O.input === 'pass') { O.turn = 0; O.phase = 'turn'; }
    else { O.phase = 'play'; O.turn = -1; offStart = performance.now() + 3000; offEnd = O.settings.time ? offStart + O.settings.time * 1000 : null; keepAwake(true); }
    saveO(); render(true);
  }
  function viewOffPlay() {
    const paper = O.input === 'paper';
    const cats = O.roundCats;
    const p = paper ? null : O.players[O.turn];
    const wrap = h('div', null,
      h('div', { class: 'topbar' }, h('div', { class: 'letterBadge' }, O.letter), h('div', { class: 'timer', id: 'timer' }, '…'), h('div', { class: 'small muted' }, paper ? 'kartki' : p.name)),
      h('div', { class: 'card' }, paper
        ? h('div', null, h('h2', null, 'Kategorie'), h('div', { class: 'chips' }, cats.map((c) => h('span', { class: 'chip' }, c.icon + ' ' + c.name))))
        : cats.map((c, i) => h('div', { class: 'field' }, h('label', { for: 'f_' + c.id }, c.icon, ' ', c.name),
          h('input', { id: 'f_' + c.id, autocomplete: 'off', autocapitalize: 'words', spellcheck: 'false', maxlength: 40, placeholder: O.letter + '…', value: (O.cur || {})[c.id] || '',
            oninput: (e) => { O.cur[c.id] = e.target.value; },
            onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); const n = $('#f_' + (cats[i + 1] || {}).id); n ? n.focus() : e.target.blur(); } } })))),
      h('div', { class: 'bottombar' }, h('div', { class: 'inner' }, h('button', { class: 'danger huge', onclick: () => { if (confirm('Zakończyć?')) offFinishTurn(); } }, '✋ Zakończ'))),
      h('div', { id: 'startOverlay', class: 'overlay', style: 'display:none' }, h('div', { class: 'muted msg' }, 'Litera'), h('div', { class: 'bigL' }, O.letter), h('div', { class: 'msg', id: 'startCount' }, '')));
    return wrap;
  }
  function offTick() {
    const now = performance.now();
    const sOv = $('#startOverlay');
    if (sOv) {
      const left = offStart - now;
      if (left > 0) { sOv.style.display = 'flex'; $('#startCount').textContent = 'Start za ' + Math.ceil(left / 1000); }
      else if (sOv.style.display !== 'none') { sOv.style.display = 'none'; const f = $('.field input'); f && f.focus(); }
    }
    const tEl = $('#timer');
    const rem = offEnd == null ? null : offEnd - now;
    if (tEl) { tEl.textContent = fmt(rem); tEl.classList.toggle('low', rem != null && rem < 10000); }
    if (rem != null && rem <= 0) { vibrate([100, 60, 100]); offFinishTurn(); }
  }
  function offFinishTurn() {
    if (O.phase !== 'play') return;
    keepAwake(false);
    if (O.input === 'paper') { O.phase = 'paperScore'; saveO(); render(true); return; }
    O.ans[O.players[O.turn].id] = sanitizeAns(O.cur);
    O.cur = {};
    O.turn += 1;
    if (O.turn < O.players.length) { O.phase = 'turn'; }
    else {
      O.R = { cats: O.roundCats, letter: O.letter, ans: O.ans, votes: {}, ovr: {} };
      O.phase = 'review';
    }
    saveO(); render(true);
  }

  // ---------- start ----------
  render(true);
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  window.PM_TEST = { scoreRound, get G() { return G; }, get O() { return O; } };
})();
