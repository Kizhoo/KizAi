/* shared.js — KizAi v2 — 40+ Web Features
   Include: <script src="/shared.js"></script> */

// ────────────────────────────────────────────────────────────
// 1. STATE & CONFIG
// ────────────────────────────────────────────────────────────
const KIZAI = {
  token: localStorage.getItem('kizai_token'),
  user:  JSON.parse(localStorage.getItem('kizai_user') || 'null'),
  prefs: JSON.parse(localStorage.getItem('kizai_prefs') || '{"theme":"dark","accent":"lime","fontSize":"md","customCursor":true,"reducedMotion":false,"soundEffects":false,"language":"id","compactView":false,"sidebarCollapsed":false}'),
  api:   '/api',
  version: '2.0.0',
};

const i18n = {
  id: { greeting:'Selamat datang', search:'Cari apa saja...', settings:'Pengaturan', logout:'Keluar', noNotif:'Tidak ada notifikasi', theme:'Tema', accent:'Warna Aksen', fontSize:'Ukuran Teks', cursor:'Kursor Kustom', motion:'Kurangi Animasi', sound:'Efek Suara', language:'Bahasa' },
  en: { greeting:'Welcome', search:'Search anything...', settings:'Settings', logout:'Logout', noNotif:'No notifications', theme:'Theme', accent:'Accent Color', fontSize:'Font Size', cursor:'Custom Cursor', motion:'Reduce Motion', sound:'Sound Effects', language:'Language' },
};
function t(key) { return i18n[KIZAI.prefs.language || 'id']?.[key] || key; }

// ────────────────────────────────────────────────────────────
// 2. FEATURE: DARK / LIGHT MODE
// ────────────────────────────────────────────────────────────
function setTheme(theme) {
  KIZAI.prefs.theme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  savePrefs();
}
function toggleTheme() { setTheme(KIZAI.prefs.theme === 'dark' ? 'light' : 'dark'); }

// Auto detect system preference
function initTheme() {
  const saved = KIZAI.prefs.theme;
  if (saved === 'auto') {
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  } else {
    document.documentElement.setAttribute('data-theme', saved || 'dark');
  }
}

// ────────────────────────────────────────────────────────────
// 3. FEATURE: ACCENT COLOR
// ────────────────────────────────────────────────────────────
const ACCENT_PRESETS = ['lime','blue','purple','pink','orange','cyan'];
function setAccent(name) {
  KIZAI.prefs.accent = name;
  document.documentElement.setAttribute('data-accent', name);
  savePrefs();
}

// ────────────────────────────────────────────────────────────
// 4. FEATURE: FONT SIZE
// ────────────────────────────────────────────────────────────
function setFontSize(size) {
  KIZAI.prefs.fontSize = size;
  document.documentElement.setAttribute('data-fs', size);
  savePrefs();
}

// ────────────────────────────────────────────────────────────
// 5. FEATURE: CUSTOM CURSOR
// ────────────────────────────────────────────────────────────
let mx = 0, my = 0, rx = 0, ry = 0;
let cursorEnabled = false;
function initCursor() {
  if (!KIZAI.prefs.customCursor) return;
  document.body.classList.add('custom-cursor');
  cursorEnabled = true;
  const dot  = document.getElementById('cursor-dot')  || createEl('div', 'cursor-dot', {id:'cursor-dot'});
  const ring = document.getElementById('cursor-ring') || createEl('div', 'cursor-ring', {id:'cursor-ring'});
  document.body.prepend(dot, ring);
  document.addEventListener('mousemove', e => { mx = e.clientX; my = e.clientY; dot.style.left = mx+'px'; dot.style.top = my+'px'; });
  (function animCursor() { rx += (mx-rx)*.12; ry += (my-ry)*.12; ring.style.left = rx+'px'; ring.style.top = ry+'px'; requestAnimationFrame(animCursor); })();
}
function toggleCursor() { KIZAI.prefs.customCursor = !KIZAI.prefs.customCursor; savePrefs(); location.reload(); }

// ────────────────────────────────────────────────────────────
// 6. FEATURE: REDUCED MOTION
// ────────────────────────────────────────────────────────────
function setReducedMotion(val) {
  KIZAI.prefs.reducedMotion = val;
  document.documentElement.setAttribute('data-reduced', val ? '1' : '0');
  savePrefs();
}

// ────────────────────────────────────────────────────────────
// 7. FEATURE: SOUND EFFECTS
// ────────────────────────────────────────────────────────────
const sounds = {};
function playSound(type) {
  if (!KIZAI.prefs.soundEffects) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    const configs = { pop:[600,.08], success:[880,.1], error:[220,.12], click:[400,.04], notif:[660,.15] };
    const [freq, dur] = configs[type] || [440,.08];
    osc.frequency.value = freq; osc.type = 'sine';
    gain.gain.setValueAtTime(.2, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(.001, ctx.currentTime + dur);
    osc.start(); osc.stop(ctx.currentTime + dur);
  } catch {}
}

// ────────────────────────────────────────────────────────────
// 8. FEATURE: SCROLL PROGRESS BAR
// ────────────────────────────────────────────────────────────
function initScrollProgress() {
  const bar = document.getElementById('scroll-prog') || (() => { const b = createEl('div','',{id:'scroll-prog'}); document.body.prepend(b); return b; })();
  window.addEventListener('scroll', () => {
    const h = document.documentElement.scrollHeight - innerHeight;
    bar.style.width = (scrollY / h * 100) + '%';
  }, { passive: true });
}

// ────────────────────────────────────────────────────────────
// 9. FEATURE: TOAST NOTIFICATIONS
// ────────────────────────────────────────────────────────────
function getToastStack() {
  return document.getElementById('toast-stack') || (() => { const s = createEl('div','',{id:'toast-stack'}); document.body.appendChild(s); return s; })();
}
function toast(msg, type = 'info', duration = 3500) {
  playSound(type === 'ok' ? 'success' : type === 'err' ? 'error' : 'notif');
  const icons = { ok:'✅', err:'❌', info:'⚡', warn:'⚠️' };
  const stack = getToastStack();
  const el = createEl('div', `toast toast-${type === 'ok' ? 'ok' : type === 'err' ? 'err' : type === 'warn' ? 'warn' : 'info'}`);
  el.innerHTML = `<span>${icons[type]||'ℹ️'}</span><span>${msg}</span>`;
  el.onclick = () => el.remove();
  stack.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateX(24px)'; setTimeout(() => el.remove(), 300); }, duration);
}

// ────────────────────────────────────────────────────────────
// 10. FEATURE: COMMAND PALETTE (Ctrl+K)
// ────────────────────────────────────────────────────────────
const CMD_ITEMS = [
  { icon:'🏠', name:'Beranda', desc:'Home', action: () => location.href = '/', section:'Navigasi' },
  { icon:'🤖', name:'KizAi Chat', desc:'AI Chat', action: () => location.href = '/chat.html', section:'Navigasi' },
  { icon:'🎮', name:'Games Hub', desc:'52+ Games', action: () => location.href = '/games.html', section:'Navigasi' },
  { icon:'🔧', name:'Tools Hub', desc:'105+ Tools', action: () => location.href = '/tools.html', section:'Navigasi' },
  { icon:'👤', name:'Dashboard', desc:'', action: () => location.href = '/dashboard.html', section:'Navigasi' },
  { icon:'⭐', name:'Order Premium', desc:'Upgrade', action: () => location.href = '/checkout.html', section:'Navigasi' },
  { icon:'⚙️', name:'Pengaturan', desc:'Settings', action: () => openSettingsModal(), section:'Aksi' },
  { icon:'🌙', name:'Toggle Dark/Light', desc:'Ubah tema', action: () => toggleTheme(), section:'Aksi' },
  { icon:'🎨', name:'Ganti Warna Aksen', desc:'Accent color', action: () => openSettingsModal('accent'), section:'Aksi' },
  { icon:'🔔', name:'Notifikasi', desc:'Lihat notif', action: () => toggleNotifPanel(), section:'Aksi' },
  { icon:'🏆', name:'Leaderboard', desc:'Top users', action: () => location.href = '/dashboard.html#leaderboard', section:'Aksi' },
  { icon:'📋', name:'Copy Referral Code', desc:'Bagikan link', action: () => copyReferral(), section:'Aksi' },
  { icon:'🚪', name:'Logout', desc:'Keluar', action: () => logout(), section:'Aksi' },
];

let cmdOpen = false, cmdIdx = 0, cmdFiltered = [];
function openCmdPalette() {
  const el = document.getElementById('cmd-palette');
  if (!el) return;
  cmdOpen = true;
  el.classList.add('open');
  setTimeout(() => el.querySelector('.cmd-input')?.focus(), 50);
  renderCmdItems('');
}
function closeCmdPalette() {
  cmdOpen = false;
  document.getElementById('cmd-palette')?.classList.remove('open');
}
function renderCmdItems(q) {
  const results = document.getElementById('cmd-results');
  if (!results) return;
  cmdFiltered = q ? CMD_ITEMS.filter(i => i.name.toLowerCase().includes(q.toLowerCase()) || i.desc.toLowerCase().includes(q.toLowerCase())) : CMD_ITEMS;
  if (!cmdFiltered.length) { results.innerHTML = `<div class="cmd-empty">Tidak ada hasil untuk "${q}"</div>`; return; }
  const sections = {};
  cmdFiltered.forEach(item => { if (!sections[item.section]) sections[item.section] = []; sections[item.section].push(item); });
  results.innerHTML = Object.entries(sections).map(([sec, items]) =>
    `<div class="cmd-section">${sec}</div>` + items.map((item, i) =>
      `<div class="cmd-item" data-idx="${cmdFiltered.indexOf(item)}" onclick="runCmd(${cmdFiltered.indexOf(item)})">
        <span class="cmd-item-icon">${item.icon}</span>
        <span class="cmd-item-name">${item.name}</span>
        <span class="cmd-item-desc">${item.desc}</span>
      </div>`).join('')).join('');
  cmdIdx = 0;
  updateCmdFocus();
}
function updateCmdFocus() {
  document.querySelectorAll('.cmd-item').forEach((el, i) => el.classList.toggle('on', i === cmdIdx));
}
function runCmd(idx) { closeCmdPalette(); cmdFiltered[idx]?.action?.(); }

// ────────────────────────────────────────────────────────────
// 11. FEATURE: NOTIFICATION CENTER
// ────────────────────────────────────────────────────────────
let notifOpen = false;
async function loadNotifications() {
  if (!KIZAI.token) return;
  try {
    const r = await api('GET', '/api/auth?action=notifications');
    renderNotifications(r.notifications || []);
    const unread = (r.notifications || []).filter(n => !n.is_read).length;
    const badge = document.getElementById('notif-badge');
    if (badge) { badge.textContent = unread; badge.style.display = unread ? '' : 'none'; }
  } catch {}
}
function renderNotifications(notifs) {
  const list = document.getElementById('notif-list');
  if (!list) return;
  if (!notifs.length) { list.innerHTML = `<div style="padding:2rem;text-align:center;color:var(--gray);font-size:.85rem">🔔 ${t('noNotif')}</div>`; return; }
  list.innerHTML = notifs.map(n => `
    <div class="notif-item${!n.is_read?' unread':''}">
      <span class="notif-icon">${n.icon||'🔔'}</span>
      <div>
        <div class="notif-title">${n.title}</div>
        <div class="notif-msg">${n.message}</div>
        <div class="notif-time">${timeAgo(n.created_at)}</div>
      </div>
      ${!n.is_read ? '<div class="notif-dot"></div>' : ''}
    </div>`).join('');
}
function toggleNotifPanel() {
  const panel = document.getElementById('notif-panel');
  if (!panel) return;
  notifOpen = !notifOpen;
  panel.classList.toggle('open', notifOpen);
  if (notifOpen) { loadNotifications(); api('PUT', '/api/auth?action=read-notifications').catch(()=>{}); }
}

// ────────────────────────────────────────────────────────────
// 12. FEATURE: ANNOUNCEMENT BANNER
// ────────────────────────────────────────────────────────────
function showAnnouncement(text, type = 'info') {
  const bar = document.getElementById('announce-bar');
  if (!bar || sessionStorage.getItem('announce-closed')) return;
  bar.className = `announce-bar ${type}`;
  bar.innerHTML = `<span>${type==='promo'?'🎉':'ℹ️'}</span><span>${text}</span><button class="announce-close" onclick="closeAnnouncement()">✕</button>`;
  bar.style.display = 'flex';
}
function closeAnnouncement() {
  const bar = document.getElementById('announce-bar');
  if (bar) bar.style.display = 'none';
  sessionStorage.setItem('announce-closed', '1');
}

// ────────────────────────────────────────────────────────────
// 13. FEATURE: LANGUAGE SWITCHER
// ────────────────────────────────────────────────────────────
function setLanguage(lang) { KIZAI.prefs.language = lang; savePrefs(); location.reload(); }

// ────────────────────────────────────────────────────────────
// 14. FEATURE: COMPACT VIEW
// ────────────────────────────────────────────────────────────
function toggleCompact() {
  KIZAI.prefs.compactView = !KIZAI.prefs.compactView;
  document.body.classList.toggle('compact', KIZAI.prefs.compactView);
  savePrefs();
}

// ────────────────────────────────────────────────────────────
// 15. FEATURE: SIDEBAR COLLAPSE
// ────────────────────────────────────────────────────────────
function toggleSidebar() {
  KIZAI.prefs.sidebarCollapsed = !KIZAI.prefs.sidebarCollapsed;
  document.body.classList.toggle('sidebar-collapsed', KIZAI.prefs.sidebarCollapsed);
  savePrefs();
}

// ────────────────────────────────────────────────────────────
// 16. FEATURE: GLOBAL SEARCH
// ────────────────────────────────────────────────────────────
function initGlobalSearch() {
  const inp = document.getElementById('global-search');
  if (!inp) return;
  inp.addEventListener('input', debounce(e => {
    const q = e.target.value.trim();
    if (q.length < 2) return hideSearchResults();
    showSearchResults(q);
  }, 300));
  inp.addEventListener('focus', () => { if (inp.value.length >= 2) showSearchResults(inp.value); });
  document.addEventListener('click', e => { if (!e.target.closest('.search-wrapper')) hideSearchResults(); });
}
function showSearchResults(q) {
  const results = document.getElementById('search-results');
  if (!results) return;
  const matches = CMD_ITEMS.filter(i => i.name.toLowerCase().includes(q.toLowerCase())).slice(0, 6);
  results.innerHTML = matches.length ? matches.map(i => `<div class="search-item" onclick="location.href='#';${i.action.toString().includes('location')? i.action.toString().match(/href\s*=\s*'([^']+)'/)?.[1]?.includes('http')?`window.location.href='${i.action.toString().match(/href\s*=\s*'([^']+)'/)?.[1]}'`:'' : ''}"><span>${i.icon}</span><span>${i.name}</span></div>`).join('') : `<div style="padding:.75rem 1rem;font-size:.82rem;color:var(--gray)">Tidak ditemukan</div>`;
  results.style.display = '';
}
function hideSearchResults() { const r = document.getElementById('search-results'); if (r) r.style.display = 'none'; }

// ────────────────────────────────────────────────────────────
// 17. FEATURE: KEYBOARD SHORTCUTS
// ────────────────────────────────────────────────────────────
function initKeyboardShortcuts() {
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); openCmdPalette(); }
    if (e.key === 'Escape') { closeCmdPalette(); closeSettingsModal(); }
    if (cmdOpen) {
      if (e.key === 'ArrowDown') { e.preventDefault(); cmdIdx = Math.min(cmdIdx+1, cmdFiltered.length-1); updateCmdFocus(); }
      if (e.key === 'ArrowUp')   { e.preventDefault(); cmdIdx = Math.max(cmdIdx-1, 0); updateCmdFocus(); }
      if (e.key === 'Enter')     { e.preventDefault(); runCmd(cmdIdx); }
    }
  });
}

// ────────────────────────────────────────────────────────────
// 18. FEATURE: COPY TO CLIPBOARD
// ────────────────────────────────────────────────────────────
function copy(text, label = 'Tersalin!') {
  navigator.clipboard.writeText(text).then(() => { toast(label, 'ok'); playSound('click'); }).catch(() => toast('Gagal copy', 'err'));
}
function copyReferral() {
  if (!KIZAI.user?.referral_code) return toast('Login dulu untuk copy referral', 'warn');
  copy(`${location.origin}/?ref=${KIZAI.user.referral_code}`, '🔗 Referral link tersalin!');
}

// ────────────────────────────────────────────────────────────
// 19. FEATURE: SKELETON LOADING
// ────────────────────────────────────────────────────────────
function showSkeleton(id, count = 3) {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = Array(count).fill(`<div class="skeleton" style="height:48px;margin-bottom:.5rem"></div>`).join('');
}

// ────────────────────────────────────────────────────────────
// 20. FEATURE: REVEAL ON SCROLL
// ────────────────────────────────────────────────────────────
function initReveal() {
  const ro = new IntersectionObserver(entries => entries.forEach(e => { if(e.isIntersecting){e.target.classList.add('in');ro.unobserve(e.target);} }), { threshold: .07 });
  document.querySelectorAll('.rv').forEach(el => ro.observe(el));
}

// ────────────────────────────────────────────────────────────
// 21. FEATURE: BACK TO TOP
// ────────────────────────────────────────────────────────────
function initBackToTop() {
  const btn = document.getElementById('btt') || (() => { const b = createEl('button','',{id:'btt',title:'Kembali ke atas'}); b.textContent='↑'; b.onclick=()=>scrollTo({top:0,behavior:'smooth'}); document.body.appendChild(b); return b; })();
  window.addEventListener('scroll', () => btn.classList.toggle('show', scrollY > 400), { passive: true });
}

// ────────────────────────────────────────────────────────────
// 22. FEATURE: ONLINE / OFFLINE INDICATOR
// ────────────────────────────────────────────────────────────
function initOnlineStatus() {
  const update = () => {
    const online = navigator.onLine;
    if (!online) toast('⚠️ Kamu offline', 'warn', 5000);
    document.querySelectorAll('.online-indicator').forEach(el => { el.style.background = online ? 'var(--green)' : 'var(--hot)'; el.title = online ? 'Online' : 'Offline'; });
  };
  window.addEventListener('online', update); window.addEventListener('offline', update);
}

// ────────────────────────────────────────────────────────────
// 23. FEATURE: PWA INSTALL PROMPT
// ────────────────────────────────────────────────────────────
let pwaPrompt = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault(); pwaPrompt = e;
  if (!localStorage.getItem('pwa-dismissed')) showPWABanner();
});
function showPWABanner() {
  const b = document.getElementById('pwa-banner');
  if (b) b.classList.remove('hidden');
}
function installPWA() {
  if (!pwaPrompt) return;
  pwaPrompt.prompt();
  pwaPrompt.userChoice.then(r => { if(r.outcome==='accepted') toast('App berhasil diinstall! 🎉','ok'); document.getElementById('pwa-banner')?.classList.add('hidden'); });
}
function dismissPWA() { localStorage.setItem('pwa-dismissed','1'); document.getElementById('pwa-banner')?.classList.add('hidden'); }

// ────────────────────────────────────────────────────────────
// 24. FEATURE: SETTINGS MODAL
// ────────────────────────────────────────────────────────────
function openSettingsModal(tab = 'appearance') {
  const overlay = document.getElementById('settings-modal');
  if (!overlay) return buildSettingsModal(tab);
  overlay.classList.add('open');
}
function closeSettingsModal() { document.getElementById('settings-modal')?.classList.remove('open'); }
function buildSettingsModal(activeTab = 'appearance') {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay'; overlay.id = 'settings-modal';
  overlay.onclick = e => { if(e.target===overlay) closeSettingsModal(); };
  overlay.innerHTML = `
  <div class="modal-box" style="max-width:560px">
    <div class="modal-head">
      <span class="modal-title">⚙️ Pengaturan</span>
      <button class="modal-close" onclick="closeSettingsModal()">✕</button>
    </div>
    <div style="display:flex;gap:.4rem;margin-bottom:1.5rem;background:var(--bg3);padding:4px;border-radius:10px">
      ${[['appearance','🎨 Tampilan'],['account','👤 Akun'],['shortcuts','⌨️ Shortcut']].map(([id,label])=>`<button onclick="switchSettingsTab('${id}')" id="stab-${id}" style="flex:1;padding:.4rem;border-radius:7px;font-size:.78rem;font-weight:600;cursor:pointer;border:none;transition:all .2s;font-family:var(--ff-b);background:${activeTab===id?'var(--card)':'transparent'};color:${activeTab===id?'var(--white)':'var(--gray)'}">${label}</button>`).join('')}
    </div>
    <div id="settings-content"></div>
  </div>`;
  document.body.appendChild(overlay);
  overlay.classList.add('open');
  renderSettingsTab(activeTab);
}
function switchSettingsTab(tab) {
  document.querySelectorAll('[id^="stab-"]').forEach(b => { const t=b.id.replace('stab-',''); b.style.background=t===tab?'var(--card)':'transparent'; b.style.color=t===tab?'var(--white)':'var(--gray)'; });
  renderSettingsTab(tab);
}
function renderSettingsTab(tab) {
  const el = document.getElementById('settings-content');
  if (!el) return;
  const p = KIZAI.prefs;
  if (tab === 'appearance') {
    el.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:1.5rem">
      <div>
        <div style="font-size:.75rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--gray2);margin-bottom:.75rem">${t('theme')}</div>
        <div style="display:flex;gap:.5rem">
          ${[['dark','🌙 Dark'],['light','☀️ Light'],['auto','⚙️ Auto']].map(([v,l])=>`<button onclick="setTheme('${v}');renderSettingsTab('appearance')" style="flex:1;padding:.6rem;border-radius:9px;font-size:.8rem;font-weight:600;cursor:pointer;border:1.5px solid ${p.theme===v?'rgba(var(--accent-rgb),.5)':'var(--bd2)'};background:${p.theme===v?'rgba(var(--accent-rgb),.1)':'var(--card2)'};color:${p.theme===v?'var(--accent)':'var(--gray)'};font-family:inherit;transition:all .2s">${l}</button>`).join('')}
        </div>
      </div>
      <div>
        <div style="font-size:.75rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--gray2);margin-bottom:.75rem">${t('accent')}</div>
        <div style="display:flex;gap:.5rem;flex-wrap:wrap">
          ${[['lime','#D4FF47'],['blue','#3B82F6'],['purple','#A855F7'],['pink','#EC4899'],['orange','#F97316'],['cyan','#06B6D4']].map(([n,c])=>`<div onclick="setAccent('${n}');renderSettingsTab('appearance')" style="width:36px;height:36px;border-radius:50%;background:${c};cursor:pointer;border:3px solid ${p.accent===n?'white':'transparent'};transition:all .2s;box-shadow:${p.accent===n?`0 0 0 2px ${c}`:''}" data-tip="${n}"></div>`).join('')}
        </div>
      </div>
      <div>
        <div style="font-size:.75rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--gray2);margin-bottom:.75rem">${t('fontSize')}</div>
        <div style="display:flex;gap:.5rem">
          ${[['sm','A','Kecil'],['md','A','Sedang'],['lg','A','Besar']].map(([v,ch,l],i)=>`<button onclick="setFontSize('${v}');renderSettingsTab('appearance')" style="flex:1;padding:.6rem;border-radius:9px;font-size:${i===0?'.75rem':i===1?'.9rem':'1.1rem'};font-weight:600;cursor:pointer;border:1.5px solid ${p.fontSize===v?'rgba(var(--accent-rgb),.5)':'var(--bd2)'};background:${p.fontSize===v?'rgba(var(--accent-rgb),.1)':'var(--card2)'};color:${p.fontSize===v?'var(--accent)':'var(--gray)'};font-family:inherit;transition:all .2s">${l}</button>`).join('')}
        </div>
      </div>
      <div style="display:flex;flex-direction:column;gap:.65rem">
        ${[['customCursor',t('cursor'),'👆'],['reducedMotion',t('motion'),'♿'],['soundEffects',t('sound'),'🔊'],['compactView','Compact View','📐']].map(([k,l,ico])=>`
        <div style="display:flex;justify-content:space-between;align-items:center;padding:.75rem 1rem;background:var(--card2);border-radius:10px;border:1px solid var(--bd)">
          <span style="font-size:.88rem">${ico} ${l}</span>
          <div onclick="togglePref('${k}')" style="width:44px;height:24px;border-radius:100px;background:${p[k]?'var(--accent)':'var(--bd2)'};cursor:pointer;transition:all .28s;position:relative">
            <div style="width:18px;height:18px;border-radius:50%;background:${p[k]?'var(--accent-fg)':'var(--gray)'};position:absolute;top:3px;${p[k]?'right:3px':'left:3px'};transition:all .28s"></div>
          </div>
        </div>`).join('')}
      </div>
      <div>
        <div style="font-size:.75rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--gray2);margin-bottom:.75rem">${t('language')}</div>
        <div style="display:flex;gap:.5rem">
          ${[['id','🇮🇩 Indonesia'],['en','🇺🇸 English']].map(([v,l])=>`<button onclick="setLanguage('${v}')" style="flex:1;padding:.6rem;border-radius:9px;font-size:.82rem;font-weight:600;cursor:pointer;border:1.5px solid ${p.language===v?'rgba(var(--accent-rgb),.5)':'var(--bd2)'};background:${p.language===v?'rgba(var(--accent-rgb),.1)':'var(--card2)'};color:${p.language===v?'var(--accent)':'var(--gray)'};font-family:inherit">${l}</button>`).join('')}
        </div>
      </div>
    </div>`;
  } else if (tab === 'account') {
    const u = KIZAI.user;
    el.innerHTML = u ? `
    <div style="display:flex;flex-direction:column;gap:1rem">
      <div style="display:flex;gap:1rem;align-items:center;padding:1rem;background:var(--card2);border-radius:12px;border:1px solid var(--bd)">
        <div style="width:52px;height:52px;border-radius:13px;background:${u.avatar_color||'#5B5FEE'};display:flex;align-items:center;justify-content:center;font-size:1.5rem">${u.avatar_emoji||'😊'}</div>
        <div><div style="font-weight:700">${u.username}</div><div style="font-size:.78rem;color:var(--gray)">${u.email||''}</div><span class="badge badge-${u.effective_plan||u.plan||'free'}">${(u.effective_plan||u.plan||'free').toUpperCase()}</span></div>
      </div>
      <div style="padding:.75rem 1rem;background:var(--card2);border-radius:10px;border:1px solid var(--bd);display:flex;justify-content:space-between">
        <span style="font-size:.85rem">🔗 Referral Code</span>
        <span style="font-family:var(--ff-m);font-size:.82rem;color:var(--accent);cursor:pointer" onclick="copy('${u.referral_code||''}')">${u.referral_code||'—'}</span>
      </div>
      <button onclick="logout()" style="width:100%;padding:.75rem;border-radius:10px;background:rgba(255,60,104,.08);border:1px solid rgba(255,60,104,.2);color:var(--hot);font-size:.88rem;font-weight:600;cursor:pointer;font-family:inherit">🚪 ${t('logout')}</button>
    </div>` : `<div style="text-align:center;padding:2rem;color:var(--gray)"><a href="/auth.html" style="color:var(--accent)">Login untuk lihat akun</a></div>`;
  } else if (tab === 'shortcuts') {
    el.innerHTML = `<div style="display:flex;flex-direction:column;gap:.5rem">
      ${[['Ctrl + K','Buka Command Palette'],['Escape','Tutup modal / palette'],['↑ ↓','Navigasi command palette'],['Enter','Jalankan perintah']].map(([k,d])=>`
      <div style="display:flex;justify-content:space-between;align-items:center;padding:.65rem .9rem;background:var(--card2);border-radius:8px;border:1px solid var(--bd)">
        <span style="font-size:.85rem;color:var(--gray)">${d}</span>
        <kbd style="font-family:var(--ff-m);font-size:.7rem;padding:.2rem .55rem;border-radius:5px;background:var(--card3);border:1px solid var(--bd2)">${k}</kbd>
      </div>`).join('')}
    </div>`;
  }
}
function togglePref(key) {
  KIZAI.prefs[key] = !KIZAI.prefs[key];
  savePrefs();
  if (key === 'soundEffects') playSound('click');
  renderSettingsTab('appearance');
}

// ────────────────────────────────────────────────────────────
// 25. FEATURE: SHARE
// ────────────────────────────────────────────────────────────
async function shareContent(title, url) {
  if (navigator.share) {
    try { await navigator.share({ title, url: url || location.href }); } catch {}
  } else {
    copy(url || location.href, '🔗 Link tersalin!');
  }
}

// ────────────────────────────────────────────────────────────
// 26-30. FEATURES: AUTH HELPERS
// ────────────────────────────────────────────────────────────
function saveUser(token, user) { KIZAI.token = token; KIZAI.user = user; localStorage.setItem('kizai_token', token); localStorage.setItem('kizai_user', JSON.stringify(user)); }
function savePrefs() { localStorage.setItem('kizai_prefs', JSON.stringify(KIZAI.prefs)); applyPrefs(); }
function applyPrefs() {
  const p = KIZAI.prefs;
  initTheme();
  setAccent(p.accent || 'lime');
  setFontSize(p.fontSize || 'md');
  document.body.classList.toggle('compact', !!p.compactView);
  document.body.classList.toggle('sidebar-collapsed', !!p.sidebarCollapsed);
  document.documentElement.setAttribute('data-reduced', p.reducedMotion ? '1' : '0');
}
function logout() { localStorage.removeItem('kizai_token'); localStorage.removeItem('kizai_user'); location.href = '/auth.html'; }
function requireAuth() { if (!KIZAI.token) { location.href = '/auth.html'; return false; } return true; }

// ────────────────────────────────────────────────────────────
// 31-35. FEATURES: API & UTILS
// ────────────────────────────────────────────────────────────
async function api(method, url, body) {
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json', ...(KIZAI.token ? { Authorization: 'Bearer ' + KIZAI.token } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!r.ok && r.status === 401) { logout(); throw new Error('Unauthorized'); }
  return r.json();
}
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
function timeAgo(ts) {
  const d = Math.floor((Date.now() - new Date(ts)) / 1000);
  if (d < 60) return 'baru saja'; if (d < 3600) return Math.floor(d/60)+'m lalu';
  if (d < 86400) return Math.floor(d/3600)+'j lalu'; return Math.floor(d/86400)+'h lalu';
}
function createEl(tag, cls, attrs = {}) { const el = document.createElement(tag); if (cls) el.className = cls; Object.entries(attrs).forEach(([k,v]) => el.setAttribute(k,v)); return el; }
function formatRp(n) { return 'Rp '+parseInt(n).toLocaleString('id'); }
function padNum(n) { return String(n).padStart(2,'0'); }

// ────────────────────────────────────────────────────────────
// 36. FEATURE: RECENT ITEMS (localStorage)
// ────────────────────────────────────────────────────────────
function addRecent(type, id, name, emoji) {
  let recents = JSON.parse(localStorage.getItem('kz_recent') || '[]');
  recents = recents.filter(r => !(r.type===type && r.id===id));
  recents.unshift({ type, id, name, emoji, ts: Date.now() });
  recents = recents.slice(0, 10);
  localStorage.setItem('kz_recent', JSON.stringify(recents));
}
function getRecents() { return JSON.parse(localStorage.getItem('kz_recent') || '[]'); }

// ────────────────────────────────────────────────────────────
// 37. FEATURE: XP COUNTER ANIMATION
// ────────────────────────────────────────────────────────────
function animNumber(el, from, to, duration = 800) {
  const start = Date.now();
  const step = () => {
    const p = Math.min((Date.now() - start) / duration, 1);
    el.textContent = Math.round(from + (to - from) * p);
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ────────────────────────────────────────────────────────────
// 38. FEATURE: CONFETTI (for achievements)
// ────────────────────────────────────────────────────────────
function confetti(x = 0.5, y = 0.3) {
  const colors = ['var(--accent)','var(--cyan)','var(--hot)','var(--amber)','#fff'];
  for (let i = 0; i < 40; i++) {
    const el = document.createElement('div');
    el.style.cssText = `position:fixed;width:8px;height:8px;border-radius:2px;background:${colors[i%colors.length]};left:${x*100}vw;top:${y*100}vh;z-index:9999;pointer-events:none;animation:confetti-fall .8s ease-out ${Math.random()*.3}s forwards`;
    el.style.setProperty('--tx', (Math.random()-0.5)*200+'px');
    el.style.setProperty('--ty', (Math.random()*-200-50)+'px');
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 1200);
  }
}
const confettiStyle = document.createElement('style');
confettiStyle.textContent = '@keyframes confetti-fall{to{transform:translate(var(--tx),var(--ty)) rotate(360deg);opacity:0}}';
document.head.appendChild(confettiStyle);

// ────────────────────────────────────────────────────────────
// 39. FEATURE: DARK/LIGHT TRANSITION (smooth)
// ────────────────────────────────────────────────────────────
function smoothThemeTransition() {
  document.documentElement.style.transition = 'background .3s, color .3s';
  setTimeout(() => document.documentElement.style.transition = '', 400);
}

// ────────────────────────────────────────────────────────────
// 40. FEATURE: NETWORK STATUS + RETRY
// ────────────────────────────────────────────────────────────
async function apiWithRetry(method, url, body, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try { return await api(method, url, body); }
    catch (e) { if (i === retries) throw e; await new Promise(r => setTimeout(r, 1000 * (i+1))); }
  }
}

// ────────────────────────────────────────────────────────────
// INIT ALL
// ────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  applyPrefs();
  if (KIZAI.prefs.customCursor) initCursor();
  initScrollProgress();
  initKeyboardShortcuts();
  initBackToTop();
  initOnlineStatus();
  initReveal();
  initGlobalSearch();

  // Load user
  if (KIZAI.token) {
    api('GET', '/api/auth?action=me').then(d => {
      if (d.user) { KIZAI.user = d.user; localStorage.setItem('kizai_user', JSON.stringify(d.user)); updateUserUI(); }
    }).catch(() => {});
    loadNotifications();
  }

  // Command palette setup
  document.getElementById('cmd-palette')?.querySelector('.cmd-input')?.addEventListener('input', e => { renderCmdItems(e.target.value); });
  document.getElementById('cmd-palette')?.addEventListener('click', e => { if(e.target.id==='cmd-palette') closeCmdPalette(); });
});

function updateUserUI() {
  const u = KIZAI.user;
  if (!u) return;
  document.querySelectorAll('.user-name').forEach(el => el.textContent = u.username);
  document.querySelectorAll('.user-avatar').forEach(el => { el.style.background = u.avatar_color||'#5B5FEE'; el.textContent = u.avatar_emoji||'😊'; });
  document.querySelectorAll('.user-plan').forEach(el => { el.textContent = (u.effective_plan||'free').toUpperCase(); el.className = `badge badge-${u.effective_plan||'free'} user-plan`; });
  document.querySelectorAll('.user-level').forEach(el => el.textContent = 'Lv.'+u.level);
  document.querySelectorAll('.user-coins').forEach(el => el.textContent = u.coins);
  document.querySelectorAll('.user-xp').forEach(el => el.textContent = u.xp);
  // Show admin btn if admin
  if (u.role === 'admin') document.querySelectorAll('.admin-only').forEach(el => el.style.display = '');
}
