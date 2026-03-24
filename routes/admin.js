'use strict';
const { Router } = require('express');
const { sb, verifyToken } = require('../lib/supabase');

const router = Router();

// Wrap promise dengan timeout untuk cegah 524 Cloudflare
function withTimeout(promise, ms = 8000, msg = 'Timeout, coba lagi') {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(msg)), ms))
  ]);
}

// Kupon store - shared dengan payment.js via lib/coupons.js
const { COUPONS_STORE } = require('../lib/coupons');

const fs = require('fs');
const CONFIG_FILE = '/tmp/kizai-admin-config.json';

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE,'utf8')); } catch { return {}; }
}
function saveConfig(cfg) {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg)); } catch {}
}

let _cfg = loadConfig();
let MAINTENANCE_MODE = _cfg.maintenance || false;
let ANNOUNCEMENT = _cfg.announcement || '';

async function getAdmin(client, headers) {
  const user = await verifyToken(client, headers.authorization);
  if (!user || user.role !== 'admin') return null;
  return user;
}

router.all('*', async (req, res) => {
  let client;
  try { client = sb(); } catch (e) { return res.status(500).json({ error: e.message }); }

  const action = req.query.action || '';

  // Public endpoints (no admin check)
  if (action === 'maintenance_status') return res.json({ maintenance: MAINTENANCE_MODE, announcement: ANNOUNCEMENT });

  if (action === 'verify') {
    const admin = await getAdmin(client, req.headers);
    if (!admin) return res.status(403).json({ error: 'Bukan admin' });
    return res.json({ ok: true, username: admin.username });
  }

  const admin = await getAdmin(client, req.headers);
  if (!admin) return res.status(403).json({ error: 'Akses ditolak' });

  /* ═══════════════════════════════════════
     MONITORING & ANALYTICS
  ═══════════════════════════════════════ */

  if (req.method === 'GET' && action === 'stats') {
    const [
      { count: totalUsers }, { count: premiumUsers }, { count: vipUsers },
      { count: bannedUsers }, { count: totalOrders }, { count: activeOrders },
      { count: totalChats }, { count: totalMessages }
    ] = await Promise.all([
      client.from('profiles').select('id',{count:'exact',head:true}),
      client.from('profiles').select('id',{count:'exact',head:true}).eq('plan','premium'),
      client.from('profiles').select('id',{count:'exact',head:true}).eq('plan','vip'),
      client.from('profiles').select('id',{count:'exact',head:true}).eq('is_banned',true),
      client.from('orders').select('id',{count:'exact',head:true}),
      client.from('orders').select('id',{count:'exact',head:true}).eq('status','approved'),
      client.from('chat_sessions').select('id',{count:'exact',head:true}),
      client.from('chat_messages').select('id',{count:'exact',head:true}),
    ]);
    const { data: rev } = await client.from('orders').select('price').eq('status','approved');
    const totalRevenue = (rev||[]).reduce((s,o)=>s+(o.price||0),0);
    return res.json({ totalUsers,premiumUsers,vipUsers,bannedUsers,totalOrders,activeOrders,totalChats,totalMessages,totalRevenue });
  }

  if (req.method === 'GET' && action === 'analytics') {
    const days = parseInt(req.query.days)||30;
    const since = new Date(Date.now()-days*86400000).toISOString();
    const { data: newUsers } = await client.from('profiles').select('created_at').gte('created_at',since).order('created_at');
    const { data: newOrders } = await client.from('orders').select('created_at,price,status').gte('created_at',since).order('created_at');
    const { data: activeUsers } = await client.from('profiles').select('id',{count:'exact',head:false}).gte('last_seen',since);
    // Group by day
    const usersByDay = {}, revByDay = {};
    (newUsers||[]).forEach(u => { const d=u.created_at.slice(0,10); usersByDay[d]=(usersByDay[d]||0)+1; });
    (newOrders||[]).forEach(o => { if(o.status==='approved'){ const d=o.created_at.slice(0,10); revByDay[d]=(revByDay[d]||0)+(o.price||0); }});
    return res.json({ usersByDay, revByDay, activeCount: (activeUsers||[]).length });
  }

  if (req.method === 'GET' && action === 'active_users') {
    const now = Date.now();
    const [
      {count: d1}, {count: d7}, {count: d30}
    ] = await Promise.all([
      client.from('profiles').select('id',{count:'exact',head:true}).gte('last_seen',new Date(now-86400000).toISOString()),
      client.from('profiles').select('id',{count:'exact',head:true}).gte('last_seen',new Date(now-7*86400000).toISOString()),
      client.from('profiles').select('id',{count:'exact',head:true}).gte('last_seen',new Date(now-30*86400000).toISOString()),
    ]);
    return res.json({ last24h: d1||0, last7d: d7||0, last30d: d30||0 });
  }

  if (req.method === 'GET' && action === 'top_users') {
    const limit = parseInt(req.query.limit)||10;
    const by = req.query.by||'xp';
    const cols = {xp:'xp',coins:'coins',games:'games_played',messages:'chat_messages',tools:'tools_used'};
    const col = cols[by]||'xp';
    const { data } = await client.from('profiles').select('id,username,plan,level,xp,coins,games_played,chat_messages,tools_used,avatar_emoji').order(col,{ascending:false}).limit(limit);
    return res.json({ users: data||[] });
  }

  if (req.method === 'GET' && action === 'model_usage') {
    const { data } = await client.from('chat_messages').select('model_id').eq('role','assistant').not('model_id','is',null);
    const counts = {};
    (data||[]).forEach(m => { counts[m.model_id]=(counts[m.model_id]||0)+1; });
    const sorted = Object.entries(counts).sort((a,b)=>b[1]-a[1]).map(([model,count])=>({model,count}));
    return res.json({ models: sorted });
  }

  if (req.method === 'GET' && action === 'revenue_stats') {
    const { data: orders } = await client.from('orders').select('price,plan,duration,created_at').eq('status','approved');
    const total = (orders||[]).reduce((s,o)=>s+(o.price||0),0);
    const byPlan = {};
    (orders||[]).forEach(o=>{ byPlan[o.plan]=(byPlan[o.plan]||0)+(o.price||0); });
    const thisMonth = new Date(); thisMonth.setDate(1); thisMonth.setHours(0,0,0,0);
    const monthRev = (orders||[]).filter(o=>new Date(o.created_at)>=thisMonth).reduce((s,o)=>s+(o.price||0),0);
    return res.json({ total, byPlan, thisMonth: monthRev, count: (orders||[]).length, avgPerOrder: total/Math.max(1,(orders||[]).length) });
  }

  if (req.method === 'GET' && action === 'system_health') {
    const mem = process.memoryUsage();
    const uptime = process.uptime();
    let dbStatus = 'ok';
    try { await client.from('profiles').select('id',{count:'exact',head:true}); } catch { dbStatus = 'error'; }
    return res.json({
      db: dbStatus,
      uptime: Math.floor(uptime),
      uptimeHuman: `${Math.floor(uptime/3600)}j ${Math.floor((uptime%3600)/60)}m`,
      memory: { used: Math.round(mem.heapUsed/1024/1024)+'MB', total: Math.round(mem.heapTotal/1024/1024)+'MB' },
      node: process.version,
      maintenance: MAINTENANCE_MODE,
      supabaseUrl: process.env.SUPABASE_URL ? '✅' : '❌',
      cfAI: process.env.CF_ACCOUNT_ID ? '✅' : '⚠️ Demo',
      ipaymu: process.env.IPAYMU_VA ? '✅' : '⚠️ Not set',
      botToken: process.env.BOT_TOKEN ? '✅' : '⚠️ Not set',
    });
  }

  if (req.method === 'GET' && action === 'chat_stats') {
    const since7d = new Date(Date.now()-7*86400000).toISOString();
    const { data: msgs } = await client.from('chat_messages').select('created_at,role').gte('created_at',since7d);
    const byDay = {};
    (msgs||[]).filter(m=>m.role==='user').forEach(m=>{ const d=m.created_at.slice(0,10); byDay[d]=(byDay[d]||0)+1; });
    return res.json({ byDay, total: (msgs||[]).filter(m=>m.role==='user').length });
  }

  if (req.method === 'GET' && action === 'referral_stats') {
    const { data } = await client.from('referrals').select('referrer_id,referred_id,coins_given,created_at').order('created_at',{ascending:false}).limit(50);
    const byReferrer = {};
    (data||[]).forEach(r=>{ byReferrer[r.referrer_id]=(byReferrer[r.referrer_id]||0)+1; });
    return res.json({ referrals: data||[], total: (data||[]).length, totalCoins: (data||[]).reduce((s,r)=>s+(r.coins_given||0),0) });
  }

  /* ═══════════════════════════════════════
     USER MANAGEMENT
  ═══════════════════════════════════════ */

  if (req.method === 'GET' && action === 'users') {
    const { data } = await client.from('profiles')
      .select('id,username,plan,role,xp,coins,level,games_played,chat_messages,tools_used,is_banned,created_at,last_seen,telegram_id,referral_code,streak')
      .order('created_at',{ascending:false}).limit(200);
    return res.json({ users: data||[] });
  }

  if (req.method === 'GET' && action === 'search_user') {
    const q = (req.query.q||'').trim().toLowerCase();
    if (!q) return res.json({ users: [] });
    const { data } = await client.from('profiles')
      .select('id,username,plan,role,xp,coins,level,is_banned,created_at,last_seen,telegram_id')
      .or(`username.ilike.%${q}%,telegram_id.ilike.%${q}%`).limit(20);
    return res.json({ users: data||[] });
  }

  if (req.method === 'GET' && action === 'user_detail') {
    const { data: profile } = await client.from('profiles').select('*').eq('id',req.query.user_id).single();
    if (!profile) return res.status(404).json({ error: 'User tidak ditemukan' });
    const { data: orders } = await client.from('orders').select('*').eq('user_id',req.query.user_id).order('created_at',{ascending:false}).limit(10);
    const { data: notifs } = await client.from('notifications').select('*').eq('user_id',req.query.user_id).order('created_at',{ascending:false}).limit(10);
    const { count: chatCount } = await client.from('chat_messages').select('id',{count:'exact',head:true}).eq('user_id',req.query.user_id);
    return res.json({ profile, orders:orders||[], notifications:notifs||[], chatCount:chatCount||0 });
  }

  if (req.method === 'POST' && action === 'edit_user') {
    const { user_id, plan, role, coins, xp } = req.body;
    const upd = { updated_at: new Date().toISOString() };
    if (plan) upd.plan = plan;
    if (role) upd.role = role;
    if (coins !== undefined) upd.coins = parseInt(coins)||0;
    if (xp !== undefined) { upd.xp = parseInt(xp)||0; upd.level = Math.floor((parseInt(xp)||0)/100)+1; }
    await client.from('profiles').update(upd).eq('id',user_id);
    return res.json({ ok: true });
  }

  if (req.method === 'POST' && action === 'grant_plan') {
    const { user_id, plan, days } = req.body;
    const expires = new Date(Date.now()+(parseInt(days)||30)*86400000).toISOString();
    await client.from('profiles').update({ plan, plan_expires: expires, updated_at: new Date().toISOString() }).eq('id',user_id);
    await client.from('notifications').insert({ user_id, type:'success', title:`🎉 Plan ${plan.toUpperCase()} Aktif!`, message:`Admin memberikan paket ${plan} selama ${days} hari.`, icon:plan==='vip'?'💎':'⭐' }).catch(()=>{});
    return res.json({ ok: true });
  }

  if (req.method === 'POST' && action === 'revoke_plan') {
    await client.from('profiles').update({ plan:'free', plan_expires:null }).eq('id',req.body.user_id);
    return res.json({ ok: true });
  }

  if (req.method === 'POST' && action === 'extend_plan') {
    const { user_id, days } = req.body;
    const { data: p } = await client.from('profiles').select('plan_expires').eq('id',user_id).single();
    const base = p?.plan_expires && new Date(p.plan_expires) > new Date() ? new Date(p.plan_expires) : new Date();
    const newExpiry = new Date(base.getTime()+(parseInt(days)||30)*86400000).toISOString();
    await client.from('profiles').update({ plan_expires: newExpiry }).eq('id',user_id);
    return res.json({ ok: true, expires: newExpiry });
  }

  if (req.method === 'POST' && action === 'reset_password') {
    const { user_id, new_password } = req.body;
    if (!new_password||new_password.length<6) return res.status(400).json({ error: 'Password minimal 6 karakter' });
    const { error: re } = await withTimeout(
      client.auth.admin.updateUserById(user_id, { password: new_password }),
      8000, 'Reset password timeout'
    ).catch(e => ({ error: { message: e.message } }));
    if (re) return res.status(500).json({ error: 'Gagal reset: ' + re.message });
    return res.json({ ok: true });
  }

  if (req.method === 'POST' && action === 'ban_user') {
    await client.from('profiles').update({ is_banned: !!req.body.banned }).eq('id',req.body.user_id);
    return res.json({ ok: true });
  }

  if (req.method === 'POST' && action === 'add_coins') {
    const { user_id, amount } = req.body;
    const { data: p } = await client.from('profiles').select('coins').eq('id',user_id).single();
    await client.from('profiles').update({ coins:(p?.coins||0)+parseInt(amount) }).eq('id',user_id);
    return res.json({ ok: true });
  }

  if (req.method === 'POST' && action === 'add_xp') {
    const { user_id, amount } = req.body;
    const { data: p } = await client.from('profiles').select('xp').eq('id',user_id).single();
    const newXp = (p?.xp||0)+parseInt(amount);
    await client.from('profiles').update({ xp:newXp, level:Math.floor(newXp/100)+1 }).eq('id',user_id);
    return res.json({ ok: true });
  }

  if (req.method === 'POST' && action === 'set_coins') {
    const { user_id, amount } = req.body;
    await client.from('profiles').update({ coins: parseInt(amount)||0 }).eq('id',user_id);
    return res.json({ ok: true });
  }

  if (req.method === 'POST' && action === 'set_xp') {
    const { user_id, amount } = req.body;
    const newXp = parseInt(amount)||0;
    await client.from('profiles').update({ xp:newXp, level:Math.floor(newXp/100)+1 }).eq('id',user_id);
    return res.json({ ok: true });
  }

  if (req.method === 'DELETE' && action === 'delete_user') {
    if (req.query.user_id === admin.id)
      return res.status(400).json({ error: 'Tidak bisa hapus akun sendiri' });
    await client.from('profiles').delete().eq('id',req.query.user_id);
    await withTimeout(
      client.auth.admin.deleteUser(req.query.user_id),
      8000, 'deleteUser timeout'
    ).catch(()=>{});
    return res.json({ ok: true });
  }

  if (req.method === 'POST' && action === 'delete_sessions') {
    const { user_id } = req.body;
    const { data: sessions } = await client.from('chat_sessions').select('id').eq('user_id',user_id);
    if (sessions?.length) {
      await client.from('chat_messages').delete().in('session_id',sessions.map(s=>s.id));
      await client.from('chat_sessions').delete().eq('user_id',user_id);
    }
    return res.json({ ok: true, deleted: sessions?.length||0 });
  }

  if (req.method === 'GET' && action === 'inactive_users') {
    const since = new Date(Date.now()-30*86400000).toISOString();
    const { data } = await client.from('profiles').select('id,username,plan,last_seen,created_at').lt('last_seen',since).order('last_seen',{ascending:true}).limit(50);
    return res.json({ users: data||[] });
  }

  if (req.method === 'GET' && action === 'expiring_plans') {
    const in7d = new Date(Date.now()+7*86400000).toISOString();
    const now = new Date().toISOString();
    const { data } = await client.from('profiles').select('id,username,plan,plan_expires,telegram_id').neq('plan','free').gte('plan_expires',now).lte('plan_expires',in7d).order('plan_expires');
    return res.json({ users: data||[] });
  }

  /* ═══════════════════════════════════════
     ORDER MANAGEMENT
  ═══════════════════════════════════════ */

  if (req.method === 'GET' && action === 'orders') {
    const { data } = await client.from('orders').select('*').order('created_at',{ascending:false}).limit(200);
    return res.json({ orders: data||[] });
  }

  if (req.method === 'GET' && action === 'order_stats') {
    const { data: orders } = await client.from('orders').select('price,plan,status,created_at').eq('status','approved');
    const total = (orders||[]).reduce((s,o)=>s+(o.price||0),0);
    const byPlan = {}; (orders||[]).forEach(o=>{ byPlan[o.plan]=(byPlan[o.plan]||0)+1; });
    const revByPlan = {}; (orders||[]).forEach(o=>{ revByPlan[o.plan]=(revByPlan[o.plan]||0)+(o.price||0); });
    return res.json({ total, count:(orders||[]).length, byPlan, revByPlan });
  }

  if (req.method === 'POST' && action === 'approve_order') {
    const { data: order } = await client.from('orders').select('*').eq('order_id',req.body.order_id).single();
    if (!order) return res.status(404).json({ error: 'Order tidak ditemukan' });
    const days = parseInt(order.duration)||30;
    const expires = new Date(Date.now()+days*86400000).toISOString();
    await client.from('orders').update({ status:'approved', activated_at:new Date().toISOString(), expires_at:expires }).eq('order_id',req.body.order_id);
    if (order.user_id) await client.from('profiles').update({ plan:order.plan, plan_expires:expires }).eq('id',order.user_id);
    return res.json({ ok: true });
  }

  if (req.method === 'POST' && action === 'reject_order') {
    await client.from('orders').update({ status:'rejected' }).eq('order_id',req.body.order_id);
    return res.json({ ok: true });
  }

  if (req.method === 'POST' && action === 'refund_order') {
    await client.from('orders').update({ status:'refunded', note:'Refunded by admin' }).eq('order_id',req.body.order_id).catch(()=>{});
    if (req.body.revoke_plan && req.body.user_id) await client.from('profiles').update({ plan:'free', plan_expires:null }).eq('id',req.body.user_id);
    return res.json({ ok: true });
  }

  if (req.method === 'POST' && action === 'bulk_approve') {
    const { data: pending } = await client.from('orders').select('*').eq('status','pending');
    let count = 0;
    for (const o of (pending||[])) {
      const days = parseInt(o.duration)||30;
      const expires = new Date(Date.now()+days*86400000).toISOString();
      await client.from('orders').update({ status:'approved', activated_at:new Date().toISOString(), expires_at:expires }).eq('order_id',o.order_id);
      if (o.user_id) await client.from('profiles').update({ plan:o.plan, plan_expires:expires }).eq('id',o.user_id);
      count++;
    }
    return res.json({ ok: true, approved: count });
  }

  if (req.method === 'GET' && action === 'payment_methods') {
    const { data } = await client.from('orders').select('payment_method').eq('status','approved');
    const counts = {};
    (data||[]).forEach(o=>{ counts[o.payment_method||'qris']=(counts[o.payment_method||'qris']||0)+1; });
    return res.json({ methods: Object.entries(counts).map(([method,count])=>({method,count})) });
  }

  /* ═══════════════════════════════════════
     NOTIFICATIONS
  ═══════════════════════════════════════ */

  if (req.method === 'POST' && action === 'broadcast') {
    const { title, message, target, type='info', icon='📢', action_url='' } = req.body;
    if (!title||!message) return res.status(400).json({ error: 'Title dan message wajib' });
    let q = client.from('profiles').select('id').limit(5000);
    if (target==='premium') q=q.eq('plan','premium');
    else if (target==='vip') q=q.eq('plan','vip');
    else if (target==='free') q=q.eq('plan','free');
    const { data: users } = await q;
    const notifs = (users||[]).map(u=>({ user_id:u.id, type, title, message, icon, action_url }));
    // Batch insert to avoid timeout with many users
    const BATCH = 100;
    for (let i = 0; i < notifs.length; i += BATCH) {
      await client.from('notifications').insert(notifs.slice(i, i + BATCH)).catch(()=>{});
    }
    return res.json({ ok: true, sent: notifs.length });
  }

  if (req.method === 'POST' && action === 'send_notif_user') {
    const { user_id, title, message, type='info', icon='🔔' } = req.body;
    await client.from('notifications').insert({ user_id, type, title, message, icon });
    return res.json({ ok: true });
  }

  if (req.method === 'POST' && action === 'send_reminder') {
    const since = new Date(Date.now()-30*86400000).toISOString();
    const { data: inactive } = await client.from('profiles').select('id').lt('last_seen',since);
    const notifs = (inactive||[]).map(u=>({ user_id:u.id, type:'info', title:'👋 Kami kangen kamu!', message:'Sudah lama tidak login. Yuk balik dan cek fitur baru KizAi!', icon:'💌' }));
    // Batch insert to avoid timeout with many users
    const BATCH = 100;
    for (let i = 0; i < notifs.length; i += BATCH) {
      await client.from('notifications').insert(notifs.slice(i, i + BATCH)).catch(()=>{});
    }
    return res.json({ ok: true, sent: notifs.length });
  }

  if (req.method === 'DELETE' && action === 'clear_old_notifs') {
    const cutoff = new Date(Date.now()-30*86400000).toISOString();
    await client.from('notifications').delete().lt('created_at',cutoff).eq('is_read',true);
    return res.json({ ok: true });
  }

  if (req.method === 'GET' && action === 'notif_log') {
    const { data } = await client.from('notifications').select('*').order('created_at',{ascending:false}).limit(100);
    return res.json({ notifications: data||[] });
  }

  /* ═══════════════════════════════════════
     COUPON MANAGEMENT
  ═══════════════════════════════════════ */

  if (req.method === 'GET' && action === 'list_coupons') {
    return res.json({ coupons: COUPONS_STORE });
  }

  if (req.method === 'POST' && action === 'create_coupon') {
    const { code, discount } = req.body;
    if (!code||!discount) return res.status(400).json({ error: 'Code dan discount wajib' });
    const d = parseFloat(discount);
    if (d<=0||d>1) return res.status(400).json({ error: 'Discount harus 0.01–1.00 (1% – 100%)' });
    if (COUPONS_STORE.find(c=>c.code===code.toUpperCase())) return res.status(409).json({ error: 'Kode sudah ada' });
    COUPONS_STORE.push({ code:code.toUpperCase(), discount:d, active:true, uses:0 });
    return res.json({ ok: true });
  }

  if (req.method === 'DELETE' && action === 'delete_coupon') {
    const idx = COUPONS_STORE.findIndex(c=>c.code===req.query.code);
    if (idx !== -1) COUPONS_STORE.splice(idx, 1);
    return res.json({ ok: true });
  }

  if (req.method === 'POST' && action === 'toggle_coupon') {
    const coupon = COUPONS_STORE.find(c=>c.code===req.body.code);
    if (!coupon) return res.status(404).json({ error: 'Kupon tidak ditemukan' });
    coupon.active = !coupon.active;
    return res.json({ ok: true, active: coupon.active });
  }

  /* ═══════════════════════════════════════
     SYSTEM
  ═══════════════════════════════════════ */

  if (req.method === 'POST' && action === 'maintenance_toggle') {
    MAINTENANCE_MODE = !!req.body.enabled;
    ANNOUNCEMENT = req.body.message||'';
    saveConfig({ maintenance: MAINTENANCE_MODE, announcement: ANNOUNCEMENT });
    return res.json({ ok: true, maintenance: MAINTENANCE_MODE });
  }

  if (req.method === 'POST' && action === 'set_announcement') {
    ANNOUNCEMENT = (req.body.message||'').slice(0,300);
    saveConfig({ maintenance: MAINTENANCE_MODE, announcement: ANNOUNCEMENT });
    return res.json({ ok: true });
  }

  if (req.method === 'GET' && action === 'leaderboard_admin') {
    const by = req.query.by||'xp';
    const cols = {xp:'xp',coins:'coins',games:'games_played',messages:'chat_messages'};
    const col = cols[by]||'xp';
    const { data } = await client.from('profiles').select('id,username,plan,level,xp,coins,games_played,chat_messages,avatar_emoji').order(col,{ascending:false}).limit(50);
    return res.json({ users: (data||[]).map((u,i)=>({...u,rank:i+1})) });
  }

  if (req.method === 'POST' && action === 'clear_activity_log') {
    const cutoff = new Date(Date.now()-30*86400000).toISOString();
    await client.from('activity_log').delete().lt('created_at',cutoff);
    return res.json({ ok: true });
  }

  if (req.method === 'POST' && action === 'reset_user_stats') {
    const { user_id } = req.body;
    await client.from('profiles').update({ xp:0, coins:50, level:1, games_played:0, chat_messages:0, tools_used:0, streak:0 }).eq('id',user_id);
    return res.json({ ok: true });
  }

  if (req.method === 'GET' && action === 'export_users') {
    const { data } = await client.from('profiles').select('id,username,plan,role,xp,coins,level,games_played,chat_messages,tools_used,is_banned,created_at,last_seen,telegram_id').order('created_at',{ascending:false});
    return res.json({ users: data||[], exported_at: new Date().toISOString() });
  }

  if (req.method === 'GET' && action === 'export_orders') {
    const { data } = await client.from('orders').select('*').order('created_at',{ascending:false});
    return res.json({ orders: data||[], exported_at: new Date().toISOString() });
  }

  return res.status(404).json({ error: `Action tidak dikenal: "${action}"` });
});

module.exports = router;
