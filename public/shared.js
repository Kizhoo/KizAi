/* KizAi v4 — Shared Utilities */
'use strict';

/* ═══════════════════════════════════════
   CONSTANTS & CONFIG
   ═══════════════════════════════════════ */
const KZ = {
  version: '4.0.0',
  name: 'KizAi',
  url: 'https://kizai.vercel.app',
  storagePrefix: 'kizai_',

  // Pricing (FIXED — Premium < VIP)
  prices: {
    premium: { 30: 29000, 90: 69000 },
    vip:     { 30: 59000, 90: 139000 }
  },

  // Plans info
  plans: {
    free:    { name: 'Free',    icon: '🆓', color: '#9ca3af', badge: 'badge-free' },
    premium: { name: 'Premium', icon: '⭐', color: '#4f7fff', badge: 'badge-premium' },
    vip:     { name: 'VIP',     icon: '💎', color: '#8b5cf6', badge: 'badge-vip' }
  },

  // AI Models
  models: [
    { id: 'llama-8b',      name: 'Llama 3.1 8B',     provider: 'Meta',      plan: 'free',    speed: 'fast',   icon: '🦙', desc: 'Model ringan, respons cepat' },
    { id: 'deepseek-7b',   name: 'DeepSeek V2',       provider: 'DeepSeek',  plan: 'free',    speed: 'fast',   icon: '🔍', desc: 'Bagus untuk coding & analisis' },
    { id: 'phi3-mini',     name: 'Phi-3 Mini',        provider: 'Microsoft', plan: 'free',    speed: 'fast',   icon: '🔬', desc: 'Model compact namun pintar' },
    { id: 'mistral-7b',    name: 'Mistral 7B',        provider: 'Mistral',   plan: 'free',    speed: 'fast',   icon: '🌪️', desc: 'Seimbang antara kecepatan & kualitas' },
    { id: 'llama-70b',     name: 'Llama 3.1 70B',     provider: 'Meta',      plan: 'premium', speed: 'medium', icon: '🦙', desc: 'Model besar, lebih cerdas' },
    { id: 'mixtral-8x7b',  name: 'Mixtral 8x7B',      provider: 'Mistral',   plan: 'premium', speed: 'medium', icon: '🌀', desc: 'MoE — sangat kapabel' },
    { id: 'deepseek-r1',   name: 'DeepSeek R1',       provider: 'DeepSeek',  plan: 'premium', speed: 'medium', icon: '🧠', desc: 'Penalaran mendalam' },
    { id: 'qwen-72b',      name: 'Qwen 2.5 72B',      provider: 'Alibaba',   plan: 'vip',     speed: 'slow',   icon: '🈷️', desc: 'Model terbesar, sangat cerdas' },
    { id: 'gemma-27b',     name: 'Gemma 2 27B',       provider: 'Google',    plan: 'vip',     speed: 'slow',   icon: '💫', desc: 'Dari Google, top-tier quality' },
    { id: 'llama-405b',    name: 'Llama 3.1 405B',    provider: 'Meta',      plan: 'vip',     speed: 'slow',   icon: '🚀', desc: 'Model terkuat yang tersedia' },
  ],

  // Coupons
  coupons: { KIZAI10: .1, HEMAT20: .2, PREMIUM50: .5, VIP30: .3, NEWUSER25: .25 },

  // Achievement list
  achievements: [
    { id: 'first_chat',   name: 'Percakapan Pertama', icon: '💬', desc: 'Kirim pesan AI pertama kamu' },
    { id: 'chat_10',      name: 'Chatterbox',         icon: '🗣️', desc: '10 pesan dalam satu hari' },
    { id: 'chat_100',     name: 'Master Chatter',     icon: '🏆', desc: '100 pesan total' },
    { id: 'tools_5',      name: 'Tool Explorer',      icon: '🔧', desc: 'Pakai 5 tools berbeda' },
    { id: 'tools_20',     name: 'Tool Master',        icon: '⚙️', desc: 'Pakai 20 tools berbeda' },
    { id: 'games_5',      name: 'Gamer',              icon: '🎮', desc: 'Main 5 game berbeda' },
    { id: 'streak_7',     name: 'Streak Seminggu',    icon: '🔥', desc: '7 hari berturut-turut login' },
    { id: 'streak_30',    name: 'Legenda Streak',     icon: '🌟', desc: '30 hari berturut-turut login' },
    { id: 'level_5',      name: 'Level 5',            icon: '⭐', desc: 'Capai level 5' },
    { id: 'level_10',     name: 'Level 10',           icon: '🌈', desc: 'Capai level 10' },
    { id: 'premium',      name: 'Subscriber',         icon: '💎', desc: 'Berlangganan Premium atau VIP' },
    { id: 'referral',     name: 'Influencer',         icon: '📢', desc: 'Refer 3 orang teman' },
  ]
};

/* ═══════════════════════════════════════
   STORAGE HELPERS
   ═══════════════════════════════════════ */
const Store = {
  get: (key, fallback = null) => {
    try { const v = localStorage.getItem(KZ.storagePrefix + key); return v ? JSON.parse(v) : fallback }
    catch { return fallback }
  },
  set: (key, val) => {
    try { localStorage.setItem(KZ.storagePrefix + key, JSON.stringify(val)) }
    catch (e) { console.warn('Storage full:', e) }
  },
  del: (key) => { try { localStorage.removeItem(KZ.storagePrefix + key) } catch {} },
  clear: () => {
    const keys = Object.keys(localStorage).filter(k => k.startsWith(KZ.storagePrefix));
    keys.forEach(k => localStorage.removeItem(k));
  }
};

/* ═══════════════════════════════════════
   AUTH HELPERS
   ═══════════════════════════════════════ */
const Auth = {
  getToken: () => Store.get('token'),
  getUser:  () => Store.get('user'),
  isLoggedIn: () => !!Store.get('token'),
  isPlan: (plan) => {
    const user = Store.get('user');
    if (!user) return false;
    const ep = user.effective_plan || user.plan || 'free';
    const ranks = { free: 0, premium: 1, vip: 2 };
    return (ranks[ep] || 0) >= (ranks[plan] || 0);
  },
  logout: () => {
    Store.del('token'); Store.del('user');
    window.location.href = '/auth';
  },
  requireAuth: (redirectTo = '/auth') => {
    if (!Auth.isLoggedIn()) { window.location.href = redirectTo; return false }
    return true;
  },
  authHeader: () => {
    const t = Auth.getToken();
    return t ? { 'Authorization': 'Bearer ' + t } : {};
  }
};

/* ═══════════════════════════════════════
   API HELPER
   ═══════════════════════════════════════ */
const API = {
  async call(endpoint, options = {}) {
    const headers = { 'Content-Type': 'application/json', ...Auth.authHeader(), ...(options.headers || {}) };
    try {
      const res = await fetch(endpoint, { ...options, headers });
      const data = await res.json().catch(() => ({ error: 'Respons tidak valid' }));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      return { data, ok: true };
    } catch (e) {
      return { error: e.message, ok: false };
    }
  },
  get:  (url, opts = {}) => API.call(url, { method: 'GET', ...opts }),
  post: (url, body, opts = {}) => API.call(url, { method: 'POST', body: JSON.stringify(body), ...opts }),
  put:  (url, body, opts = {}) => API.call(url, { method: 'PUT', body: JSON.stringify(body), ...opts }),
  del:  (url, opts = {}) => API.call(url, { method: 'DELETE', ...opts }),
};

/* ═══════════════════════════════════════
   TOAST SYSTEM
   ═══════════════════════════════════════ */
const Toast = {
  _stack: null,
  _init() {
    if (!this._stack) {
      this._stack = document.getElementById('toast-stack');
      if (!this._stack) {
        this._stack = document.createElement('div');
        this._stack.id = 'toast-stack';
        document.body.appendChild(this._stack);
      }
    }
  },
  show(message, type = 'info', duration = 4000) {
    this._init();
    const icons = { ok: '✓', err: '✕', info: 'ℹ', warn: '⚠' };
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.innerHTML = `<span>${icons[type] || icons.info}</span><span>${message}</span>`;
    t.onclick = () => this._remove(t);
    this._stack.appendChild(t);
    setTimeout(() => this._remove(t), duration);
    return t;
  },
  _remove(el) {
    el.style.animation = 'toast-out .3s var(--ease) both';
    setTimeout(() => el.remove(), 300);
  },
  ok:   (m, d) => Toast.show(m, 'ok', d),
  err:  (m, d) => Toast.show(m, 'err', d),
  info: (m, d) => Toast.show(m, 'info', d),
  warn: (m, d) => Toast.show(m, 'warn', d),
};

// Global alias
window.toast = (m, t, d) => Toast.show(m, t, d);

/* ═══════════════════════════════════════
   MODAL SYSTEM
   ═══════════════════════════════════════ */
const Modal = {
  open(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.add('open');
    document.body.style.overflow = 'hidden';
    el.addEventListener('click', e => { if (e.target === el) Modal.close(id); }, { once: true });
  },
  close(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.remove('open');
    document.body.style.overflow = '';
  },
  closeAll() {
    document.querySelectorAll('.modal-overlay.open').forEach(m => {
      m.classList.remove('open');
    });
    document.body.style.overflow = '';
  },
  confirm(title, message, onConfirm, type = 'danger') {
    const id = 'confirm-modal-' + Date.now();
    const btnClass = type === 'danger' ? 'btn-danger' : 'btn-primary';
    const btnText = type === 'danger' ? '🗑️ Hapus' : '✓ Konfirmasi';
    const div = document.createElement('div');
    div.id = id;
    div.className = 'modal-overlay';
    div.innerHTML = `
      <div class="modal"><div class="modal-inner">
        <div class="modal-head">
          <span class="modal-title">${title}</span>
          <button class="modal-close" onclick="Modal.close('${id}')">✕</button>
        </div>
        <p style="color:var(--gray);font-size:.9rem;line-height:1.7;margin-bottom:1.5rem">${message}</p>
        <div class="flex gap-3" style="justify-content:flex-end">
          <button class="btn btn-outline btn-sm" onclick="Modal.close('${id}')">Batal</button>
          <button class="btn ${btnClass} btn-sm" id="${id}-confirm">${btnText}</button>
        </div>
      </div></div>`;
    document.body.appendChild(div);
    document.getElementById(id + '-confirm').onclick = () => { Modal.close(id); onConfirm(); setTimeout(() => div.remove(), 400); };
    Modal.open(id);
  }
};

/* ═══════════════════════════════════════
   THEME MANAGER
   ═══════════════════════════════════════ */
const Theme = {
  init() {
    const p = Store.get('prefs') || {};
    document.documentElement.setAttribute('data-theme', p.theme || 'dark');
    document.documentElement.setAttribute('data-accent', p.accent || 'blue');
    document.documentElement.setAttribute('data-fs', p.fontSize || 'md');
    if (p.reducedMotion) document.documentElement.setAttribute('data-reduced', '1');
  },
  setTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    const p = Store.get('prefs') || {};
    Store.set('prefs', { ...p, theme: t });
  },
  setAccent(a) {
    document.documentElement.setAttribute('data-accent', a);
    const p = Store.get('prefs') || {};
    Store.set('prefs', { ...p, accent: a });
  },
  setFontSize(fs) {
    document.documentElement.setAttribute('data-fs', fs);
    const p = Store.get('prefs') || {};
    Store.set('prefs', { ...p, fontSize: fs });
  },
  toggle() {
    const current = document.documentElement.getAttribute('data-theme');
    Theme.setTheme(current === 'dark' ? 'light' : 'dark');
  }
};

/* ═══════════════════════════════════════
   FORMAT HELPERS
   ═══════════════════════════════════════ */
const Format = {
  number: (n) => new Intl.NumberFormat('id-ID').format(n),
  currency: (n) => 'Rp ' + new Intl.NumberFormat('id-ID').format(n),
  date: (d, opts = {}) => new Date(d).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric', ...opts }),
  time: (d) => new Date(d).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }),
  datetime: (d) => Format.date(d) + ', ' + Format.time(d),
  relativeTime: (d) => {
    const diff = Date.now() - new Date(d).getTime();
    const seconds = Math.floor(diff / 1000);
    if (seconds < 60) return 'baru saja';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} menit lalu`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} jam lalu`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days} hari lalu`;
    const months = Math.floor(days / 30);
    if (months < 12) return `${months} bulan lalu`;
    return `${Math.floor(months / 12)} tahun lalu`;
  },
  fileSize: (bytes) => {
    if (bytes === 0) return '0 B';
    const k = 1024, sizes = ['B','KB','MB','GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  },
  xpForLevel: (level) => Math.floor(100 * Math.pow(1.4, level - 1)),
  levelProgress: (xp) => {
    let level = 1;
    while (xp >= Format.xpForLevel(level)) { xp -= Format.xpForLevel(level); level++; }
    return { level, current: xp, needed: Format.xpForLevel(level), pct: Math.round((xp / Format.xpForLevel(level)) * 100) };
  },
  truncate: (str, len = 60) => str?.length > len ? str.slice(0, len) + '...' : str,
  escape: (str) => str?.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;') || '',
};

/* ═══════════════════════════════════════
   DOM HELPERS
   ═══════════════════════════════════════ */
const DOM = {
  q:   (sel, ctx = document) => ctx.querySelector(sel),
  qa:  (sel, ctx = document) => [...ctx.querySelectorAll(sel)],
  on:  (el, ev, fn, opts) => el?.addEventListener(ev, fn, opts),
  off: (el, ev, fn) => el?.removeEventListener(ev, fn),
  cls: (el, ...classes) => el?.classList.add(...classes),
  ucls:(el, ...classes) => el?.classList.remove(...classes),
  tcls:(el, cls) => el?.classList.toggle(cls),
  show:(el) => el && (el.style.display = ''),
  hide:(el) => el && (el.style.display = 'none'),
  html:(el, h) => el && (el.innerHTML = h),
  text:(el, t) => el && (el.textContent = t),
  val: (el, v) => el ? (v !== undefined ? (el.value = v) : el.value) : '',
  attr:(el, a, v) => v !== undefined ? el?.setAttribute(a, v) : el?.getAttribute(a),
  data:(el, k, v) => v !== undefined ? el?.setAttribute('data-' + k, v) : el?.getAttribute('data-' + k),
  create: (tag, attrs = {}, children = []) => {
    const el = document.createElement(tag);
    Object.entries(attrs).forEach(([k, v]) => {
      if (k === 'className') el.className = v;
      else if (k === 'style') Object.assign(el.style, v);
      else if (k.startsWith('on')) el[k] = v;
      else el.setAttribute(k, v);
    });
    children.forEach(c => el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
    return el;
  }
};

/* ═══════════════════════════════════════
   SCROLL & ANIMATIONS
   ═══════════════════════════════════════ */
const Scroll = {
  init() {
    this._scrollBar = document.getElementById('scroll-bar');
    this._btt = document.getElementById('btt');
    if (this._btt) this._btt.onclick = () => window.scrollTo({ top: 0, behavior: 'smooth' });
    window.addEventListener('scroll', () => this._onScroll(), { passive: true });
    this._initReveal();
  },
  _onScroll() {
    const pct = window.scrollY / (document.documentElement.scrollHeight - window.innerHeight) * 100;
    if (this._scrollBar) this._scrollBar.style.width = pct + '%';
    if (this._btt) this._btt.classList.toggle('show', window.scrollY > 400);
  },
  _initReveal() {
    const els = document.querySelectorAll('.rv');
    if (!els.length) return;
    const io = new IntersectionObserver(entries => {
      entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
    }, { threshold: .15 });
    els.forEach(el => io.observe(el));
  }
};

/* ═══════════════════════════════════════
   COMMAND PALETTE
   ═══════════════════════════════════════ */
const Cmd = {
  items: [],
  query: '',
  selected: 0,

  register(items) { this.items = [...this.items, ...items]; },
  init() {
    const cmd = document.getElementById('cmd');
    if (!cmd) return;
    const input = cmd.querySelector('.cmd-input');
    if (input) {
      input.oninput = () => { this.query = input.value; this.render(); };
      input.onkeydown = (e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); this.move(1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); this.move(-1); }
        else if (e.key === 'Enter') { e.preventDefault(); this.exec(); }
        else if (e.key === 'Escape') { e.preventDefault(); this.close(); }
      };
    }
    cmd.onclick = (e) => { if (e.target === cmd) this.close(); };
    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); this.toggle(); }
    });
    this.render();
  },
  toggle() { const cmd = document.getElementById('cmd'); if (cmd) { cmd.classList.toggle('open'); if (cmd.classList.contains('open')) { cmd.querySelector('.cmd-input')?.focus(); this.render(); } } },
  open() { document.getElementById('cmd')?.classList.add('open'); document.querySelector('.cmd-input')?.focus(); },
  close() { document.getElementById('cmd')?.classList.remove('open'); },
  move(dir) { const list = document.querySelectorAll('.cmd-item'); const max = list.length - 1; this.selected = Math.max(0, Math.min(max, this.selected + dir)); list.forEach((el, i) => el.classList.toggle('active', i === this.selected)); },
  exec() { const items = document.querySelectorAll('.cmd-item'); if (items[this.selected]) items[this.selected].click(); },
  render() {
    const list = document.getElementById('cmd-list');
    if (!list) return;
    const q = this.query.toLowerCase();
    const filtered = this.items.filter(i => !q || i.name.toLowerCase().includes(q) || (i.desc||'').toLowerCase().includes(q));
    if (!filtered.length) { list.innerHTML = '<div style="padding:2rem;text-align:center;color:var(--gray);font-size:.85rem">Tidak ditemukan</div>'; return; }
    const grouped = {};
    filtered.forEach(i => { (grouped[i.group || 'Lainnya'] = grouped[i.group || 'Lainnya'] || []).push(i); });
    list.innerHTML = Object.entries(grouped).map(([g, items]) =>
      `<div class="cmd-section">${g}</div>` +
      items.map((item, i) => `<div class="cmd-item${i === 0 && g === Object.keys(grouped)[0] ? ' active' : ''}" onclick="${item.action || ''}"><div class="cmd-item-icon">${item.icon}</div><div><div class="cmd-item-name">${item.name}</div>${item.desc ? `<div class="cmd-item-desc">${item.desc}</div>` : ''}</div>${item.kbd ? `<kbd class="cmd-kbd">${item.kbd}</kbd>` : ''}</div>`).join('')
    ).join('');
    this.selected = 0;
  }
};

/* ═══════════════════════════════════════
   CLIPBOARD
   ═══════════════════════════════════════ */
const Clipboard = {
  async copy(text, msg = 'Disalin!') {
    try {
      await navigator.clipboard.writeText(text);
      Toast.ok(msg);
      return true;
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); Toast.ok(msg); return true; }
      catch { Toast.err('Gagal menyalin'); return false; }
      finally { ta.remove(); }
    }
  }
};

/* ═══════════════════════════════════════
   VALIDATION
   ═══════════════════════════════════════ */
const Validate = {
  email: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
  username: (v) => /^[a-zA-Z0-9_]{3,20}$/.test(v),
  password: (v) => v?.length >= 6,
  required: (v) => !!v?.trim(),
  minLen: (v, n) => v?.length >= n,
  maxLen: (v, n) => v?.length <= n,
};

/* ═══════════════════════════════════════
   MARKDOWN RENDERER (lightweight)
   ═══════════════════════════════════════ */
const MD = {
  render(text) {
    if (!text) return '';
    return text
      // Code blocks
      .replace(/```(\w+)?\n?([\s\S]*?)```/g, (_, lang, code) =>
        `<div class="code-block"><div class="code-block-header"><span class="code-block-lang">${lang || 'text'}</span><button class="btn btn-xs btn-ghost" onclick="Clipboard.copy(this.closest('.code-block').querySelector('.code-block-body').textContent, 'Kode disalin!')">📋 Copy</button></div><div class="code-block-body">${Format.escape(code.trim())}</div></div>`)
      // Inline code
      .replace(/`([^`]+)`/g, '<code style="font-family:var(--ff-mono);background:var(--bg3);padding:.1em .4em;border-radius:4px;font-size:.88em;color:var(--accent)">$1</code>')
      // Bold
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      // Italic
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      // Links
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:underline">$1</a>')
      // Headers
      .replace(/^### (.+)$/gm, '<h3 style="font-family:var(--ff-display);font-weight:700;font-size:1.05rem;margin:.85rem 0 .4rem">$1</h3>')
      .replace(/^## (.+)$/gm, '<h2 style="font-family:var(--ff-display);font-weight:700;font-size:1.2rem;margin:1rem 0 .5rem">$1</h2>')
      .replace(/^# (.+)$/gm, '<h1 style="font-family:var(--ff-display);font-weight:700;font-size:1.4rem;margin:1rem 0 .5rem">$1</h1>')
      // Unordered list
      .replace(/^- (.+)$/gm, '<li style="margin:.25rem 0;padding-left:.5rem">$1</li>')
      .replace(/(<li[^>]*>.*<\/li>\n?)+/g, '<ul style="list-style:none;margin:.5rem 0;padding-left:1.2rem">$&</ul>')
      // Ordered list
      .replace(/^\d+\. (.+)$/gm, '<li style="margin:.25rem 0;padding-left:.5rem">$1</li>')
      // Horizontal rule
      .replace(/^---$/gm, '<hr style="border:none;border-top:1px solid var(--bd);margin:1rem 0">')
      // Paragraphs
      .replace(/\n\n+/g, '</p><p style="margin:.5rem 0">')
      .replace(/\n/g, '<br>');
  }
};

/* ═══════════════════════════════════════
   LAZY IMAGE LOADER
   ═══════════════════════════════════════ */
const LazyImg = {
  init() {
    const imgs = document.querySelectorAll('img[data-src]');
    if (!imgs.length) return;
    const io = new IntersectionObserver(entries => {
      entries.forEach(e => {
        if (e.isIntersecting) {
          e.target.src = e.target.dataset.src;
          io.unobserve(e.target);
        }
      });
    });
    imgs.forEach(img => io.observe(img));
  }
};

/* ═══════════════════════════════════════
   KEYBOARD SHORTCUTS
   ═══════════════════════════════════════ */
const Keys = {
  shortcuts: [],
  add(key, fn, desc = '') {
    this.shortcuts.push({ key, fn, desc });
    document.addEventListener('keydown', (e) => {
      const k = (e.ctrlKey || e.metaKey ? 'ctrl+' : '') + (e.shiftKey ? 'shift+' : '') + (e.altKey ? 'alt+' : '') + e.key.toLowerCase();
      if (k === key.toLowerCase() && !['input','textarea','select'].includes(document.activeElement?.tagName?.toLowerCase())) {
        e.preventDefault(); fn(e);
      }
    });
  }
};

/* ═══════════════════════════════════════
   PLAN CHECKER UI
   ═══════════════════════════════════════ */
function requirePlan(minPlan, featureName) {
  if (Auth.isPlan(minPlan)) return true;
  const planInfo = KZ.plans[minPlan];
  Modal.confirm(
    `Fitur ${planInfo.name}`,
    `<b>${featureName}</b> hanya tersedia untuk pengguna <b>${planInfo.name}</b> ${planInfo.icon}.<br><br>Upgrade sekarang untuk mengakses fitur ini dan 100+ fitur premium lainnya!`,
    () => { window.location.href = `/checkout?plan=${minPlan}`; },
    'primary'
  );
  document.getElementById('confirm-modal-' + (document.querySelectorAll('.modal-overlay').length) + '-confirm').textContent = `Upgrade ke ${planInfo.name} ${planInfo.icon}`;
  return false;
}

/* ═══════════════════════════════════════
   NOTIFICATION SYSTEM (UI)
   ═══════════════════════════════════════ */
const Notif = {
  _unread: 0,
  async load() {
    if (!Auth.isLoggedIn()) return;
    const { data } = await API.get('/api/auth?action=notifications');
    if (data?.notifications) {
      this._unread = data.notifications.filter(n => !n.is_read).length;
      this._render(data.notifications);
      this._updateBadge();
    }
  },
  _render(notifs) {
    const list = document.getElementById('notif-list');
    if (!list) return;
    if (!notifs.length) {
      list.innerHTML = '<div class="notif-empty">🔔 Tidak ada notifikasi</div>'; return;
    }
    list.innerHTML = notifs.map(n => `
      <div class="notif-item${n.is_read ? '' : ' unread'}" onclick="Notif.read('${n.id}')">
        <div class="notif-ico">${n.icon || '🔔'}</div>
        <div class="flex-col" style="gap:.15rem;flex:1;min-width:0">
          <div class="notif-title">${Format.escape(n.title)}</div>
          <div class="notif-msg">${Format.escape(n.message)}</div>
          <div class="notif-time">${Format.relativeTime(n.created_at)}</div>
        </div>
      </div>`).join('');
  },
  async read(id) {
    await API.post('/api/auth?action=read_notification', { id });
    this._unread = Math.max(0, this._unread - 1);
    this._updateBadge();
  },
  async readAll() {
    await API.post('/api/auth?action=read_all_notifications', {});
    this._unread = 0; this._updateBadge();
    document.querySelectorAll('.notif-item.unread').forEach(el => el.classList.remove('unread'));
  },
  _updateBadge() {
    const badge = document.getElementById('notif-badge');
    if (!badge) return;
    badge.textContent = this._unread;
    badge.style.display = this._unread > 0 ? '' : 'none';
  },
  toggle() {
    const panel = document.getElementById('notif-panel');
    if (!panel) return;
    panel.classList.toggle('open');
    if (panel.classList.contains('open')) this.load();
  }
};

/* ═══════════════════════════════════════
   NAV HELPER
   ═══════════════════════════════════════ */
function buildNav(activePage = '') {
  const user = Auth.getUser();
  const loggedIn = Auth.isLoggedIn();
  const plan = user?.effective_plan || user?.plan || 'free';
  const planInfo = KZ.plans[plan] || KZ.plans.free;

  const navEl = document.getElementById('main-nav');
  if (!navEl) return;

  const links = [
    { href: '/', label: 'Beranda', key: 'home' },
    { href: '/chat', label: '💬 Chat AI', key: 'chat' },
    { href: '/tools', label: '🔧 Tools', key: 'tools' },
    { href: '/games', label: '🎮 Games', key: 'games' },
    { href: '/leaderboard', label: '🏆 Leaderboard', key: 'leaderboard' },
  ];

  navEl.innerHTML = `
    <div class="nav-brand">
      <a href="/" style="display:flex;align-items:center;gap:.5rem;font-family:var(--ff-display);font-weight:800;font-size:1.3rem;letter-spacing:-.04em">
        <span style="background:linear-gradient(135deg,var(--accent),var(--cyan));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text">Kiz</span><span style="color:var(--white)">Ai</span>
      </a>
    </div>
    <nav class="nav-links" id="nav-links-inner">
      ${links.map(l => `<a href="${l.href}" class="nav-link${l.key === activePage ? ' nav-link-active' : ''}">${l.label}</a>`).join('')}
    </nav>
    <div class="nav-right">
      <button class="btn btn-ghost btn-sm nav-link" onclick="Cmd.toggle()" data-tip="⌘K">⌘K</button>
      <button class="btn btn-ghost btn-sm" onclick="Theme.toggle()" id="theme-btn" data-tip="Toggle tema">🌙</button>
      ${loggedIn ? `
        <div style="position:relative">
          <button class="btn btn-ghost btn-sm" onclick="Notif.toggle()" data-tip="Notifikasi">
            🔔<span id="notif-badge" class="badge badge-premium" style="position:absolute;top:-4px;right:-4px;padding:.1rem .3rem;font-size:.5rem;display:none">0</span>
          </button>
          <div class="notif-panel" id="notif-panel">
            <div class="notif-head">
              <span class="h4" style="font-size:.9rem">Notifikasi</span>
              <button class="btn btn-xs btn-ghost" onclick="Notif.readAll()">Tandai Semua</button>
            </div>
            <div class="notif-list" id="notif-list"><div class="notif-empty">Memuat...</div></div>
          </div>
        </div>
        <a href="/dashboard" class="btn btn-sm btn-secondary" style="gap:.4rem">
          <span style="font-size:.9rem">${planInfo.icon}</span>
          <span>${user.username}</span>
        </a>
      ` : `
        <a href="/auth" class="btn btn-sm btn-outline">Masuk</a>
        <a href="/auth#register" class="btn btn-sm btn-primary">Daftar Gratis</a>
      `}
      <button class="btn btn-ghost btn-sm hamburger" onclick="toggleMobileMenu()" id="hamburger-btn" style="display:none">☰</button>
    </div>
    <div id="mobile-menu" style="display:none;position:fixed;inset:0;background:rgba(5,5,16,.97);z-index:9999;flex-direction:column;align-items:center;justify-content:center;gap:1.5rem">
      <button onclick="toggleMobileMenu()" style="position:absolute;top:1.5rem;right:1.5rem;background:none;border:none;color:var(--white);font-size:1.5rem;cursor:pointer">✕</button>
      ${links.map(l => `<a href="${l.href}" style="font-family:var(--ff-display);font-size:1.5rem;font-weight:700;color:var(--${l.key === activePage ? 'accent' : 'white'})">${l.label}</a>`).join('')}
      ${loggedIn ? `<a href="/dashboard" class="btn btn-md btn-primary">Dashboard →</a>` : `<a href="/auth" class="btn btn-md btn-primary">Masuk / Daftar →</a>`}
    </div>`;

  // Update theme button
  const themeBtn = document.getElementById('theme-btn');
  if (themeBtn) {
    const updateThemeIcon = () => {
      themeBtn.textContent = document.documentElement.getAttribute('data-theme') === 'dark' ? '🌙' : '☀️';
    };
    updateThemeIcon();
    themeBtn.onclick = () => { Theme.toggle(); updateThemeIcon(); };
  }

  // Nav scroll effect
  const nav = navEl;
  window.addEventListener('scroll', () => {
    nav.classList.toggle('nav-scrolled', window.scrollY > 20);
  }, { passive: true });

  // Responsive hamburger
  const checkWidth = () => {
    const hamburger = document.getElementById('hamburger-btn');
    const navLinksInner = document.getElementById('nav-links-inner');
    if (hamburger) hamburger.style.display = window.innerWidth < 768 ? '' : 'none';
    if (navLinksInner) navLinksInner.style.display = window.innerWidth < 768 ? 'none' : '';
  };
  window.addEventListener('resize', checkWidth);
  checkWidth();
}

window.toggleMobileMenu = function() {
  const menu = document.getElementById('mobile-menu');
  if (menu) menu.style.display = menu.style.display === 'none' ? 'flex' : 'none';
};

/* ═══════════════════════════════════════
   GLOBAL INIT
   ═══════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  Theme.init();
  Scroll.init();
  Cmd.init();
  LazyImg.init();

  // Global close handlers
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      Modal.closeAll();
      Cmd.close();
      document.querySelectorAll('.notif-panel.open').forEach(p => p.classList.remove('open'));
      document.querySelectorAll('.ctx-menu').forEach(m => m.remove());
    }
  });

  // Click outside to close panels
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.notif-panel') && !e.target.closest('[onclick*="Notif.toggle"]')) {
      document.querySelectorAll('.notif-panel.open').forEach(p => p.classList.remove('open'));
    }
    if (!e.target.closest('.ctx-menu')) {
      document.querySelectorAll('.ctx-menu').forEach(m => m.remove());
    }
  });

  // Update user plan display
  const user = Auth.getUser();
  if (user) {
    const planBadge = document.getElementById('user-plan-badge');
    const plan = user.effective_plan || user.plan || 'free';
    if (planBadge) {
      planBadge.textContent = KZ.plans[plan]?.icon + ' ' + KZ.plans[plan]?.name;
      planBadge.className = `badge ${KZ.plans[plan]?.badge || 'badge-free'}`;
    }
    // Load notifications
    setTimeout(() => Notif.load(), 1500);
  }

  // Default command palette items
  Cmd.register([
    { group: 'Navigasi', name: 'Beranda', icon: '🏠', desc: 'Halaman utama', action: "location.href='/'", kbd: 'H' },
    { group: 'Navigasi', name: 'Chat AI', icon: '💬', desc: 'Mulai chat dengan AI', action: "location.href='/chat'", kbd: 'C' },
    { group: 'Navigasi', name: 'Tools', icon: '🔧', desc: '105+ tools gratis', action: "location.href='/tools'", kbd: 'T' },
    { group: 'Navigasi', name: 'Games', icon: '🎮', desc: '52+ mini games', action: "location.href='/games'", kbd: 'G' },
    { group: 'Navigasi', name: 'Leaderboard', icon: '🏆', desc: 'Ranking pengguna', action: "location.href='/leaderboard'", kbd: 'L' },
    { group: 'Navigasi', name: 'Dashboard', icon: '📊', desc: 'Profil & statistik', action: "location.href='/dashboard'", kbd: 'D' },
    { group: 'Tema', name: 'Toggle Dark/Light', icon: '🌙', desc: 'Ganti tema tampilan', action: "Theme.toggle()" },
    { group: 'Aksi', name: 'Upgrade Premium', icon: '⭐', desc: 'Mulai dari Rp 29.000', action: "location.href='/checkout?plan=premium'" },
    { group: 'Aksi', name: 'Upgrade VIP', icon: '💎', desc: 'Akses penuh semua fitur', action: "location.href='/checkout?plan=vip'" },
  ]);
});

// Export for module usage
if (typeof module !== 'undefined') module.exports = { KZ, Store, Auth, API, Toast, Modal, Theme, Format, DOM, Scroll, Cmd, Clipboard, Validate, MD, Notif };
