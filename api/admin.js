'use strict';
const { sb, verifyToken, cors, effectivePlan, accessibleModels } = require('../lib/supabase');
const fetch = require('node-fetch');

const BOT_TOKEN = process.env.BOT_TOKEN || '';

async function sendTelegram(chatId, text) {
  if (!BOT_TOKEN || !chatId) return;
  try { await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ chat_id: String(chatId), text, parse_mode: 'Markdown' }), timeout: 8000 }); } catch {}
}


/* ── Body parser ──────────────────────────────────────────────
   Vercel modern (@vercel/node) sudah auto-parse JSON body.
   Fungsi ini handle SEMUA kasus: sudah di-parse, belum, atau error.
   ─────────────────────────────────────────────────────────────── */
async function parseBody(req) {
  // Kasus 1: Vercel sudah parse (format functions modern)
  if (req.body !== undefined) {
    if (typeof req.body === 'object' && req.body !== null) return req.body;
    if (typeof req.body === 'string') {
      try { return JSON.parse(req.body); } catch { return {}; }
    }
    return {};
  }
  // Kasus 2: Belum di-parse (format builds lama) — baca stream manual
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk.toString(); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
    // Timeout safety — kalau 3 detik tidak ada event, resolve kosong
    setTimeout(() => resolve({}), 3000);
  });
}

module.exports = async (req, res) => {
  cors(res, req);
  req.body = await parseBody(req);
  if (req.method === 'OPTIONS') return res.status(200).end();

  let client;
  try { client = sb(); } catch (e) { return res.status(500).json({ error: e.message }); }

  // Verify admin
  const user = await verifyToken(client, req.headers.authorization);
  if (!user) return res.status(401).json({ error: 'Tidak terautentikasi' });

  const action = req.query.action || '';

  // ── VERIFY (check if admin) ──
  if (action === 'verify') {
    if (user.role !== 'admin') return res.status(403).json({ error: 'Akses ditolak — bukan admin' });
    return res.json({ ok: true, role: user.role, username: user.username });
  }

  if (user.role !== 'admin') return res.status(403).json({ error: 'Akses admin diperlukan' });

  // ── STATS ──
  if (req.method === 'GET' && action === 'stats') {
    const [
      { count: total_users },
      { count: premium_users },
      { count: vip_users },
      { count: pending_orders },
      { count: total_orders },
      { data: revenue_data },
      { count: total_messages },
      { count: active_today },
      { count: new_today },
    ] = await Promise.all([
      client.from('profiles').select('*', { count: 'exact', head: true }),
      client.from('profiles').select('*', { count: 'exact', head: true }).eq('plan', 'premium'),
      client.from('profiles').select('*', { count: 'exact', head: true }).eq('plan', 'vip'),
      client.from('orders').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
      client.from('orders').select('*', { count: 'exact', head: true }),
      client.from('orders').select('price').eq('status', 'approved'),
      client.from('chat_messages').select('*', { count: 'exact', head: true }),
      client.from('profiles').select('*', { count: 'exact', head: true }).gte('last_seen', new Date(Date.now() - 86400000).toISOString()),
      client.from('profiles').select('*', { count: 'exact', head: true }).gte('created_at', new Date(Date.now() - 86400000).toISOString()),
    ]);
    const revenue_month = (revenue_data || []).reduce((sum, o) => sum + (o.price || 0), 0);
    return res.json({ stats: { total_users, premium_users, vip_users, pending_orders, total_orders, revenue_month, total_messages, active_today, new_today, uptime: '99.9%' } });
  }

  // ── GET USERS ──
  if (req.method === 'GET' && action === 'users') {
    const page = parseInt(req.query.page) || 1;
    const limit = 50;
    const from = (page - 1) * limit;
    let query = client.from('profiles').select('*').order('created_at', { ascending: false }).range(from, from + limit - 1);
    const search = req.query.search;
    if (search) query = query.or(`username.ilike.%${search}%`);
    const planFilter = req.query.plan;
    if (planFilter && planFilter !== 'banned') query = query.eq('plan', planFilter);
    if (planFilter === 'banned') query = query.eq('is_banned', true);
    const { data } = await query;
    return res.json({ users: data || [] });
  }

  // ── EDIT USER ──
  if (req.method === 'POST' && action === 'edit_user') {
    const { user_id, plan, coins, xp, role } = req.body || {};
    if (!user_id) return res.status(400).json({ error: 'user_id wajib' });
    const updates = { updated_at: new Date().toISOString() };
    if (plan) {
      updates.plan = plan;
      if (plan !== 'free') updates.plan_expires = new Date(Date.now() + 30 * 86400000).toISOString();
    }
    if (coins) {
      const { data: p } = await client.from('profiles').select('coins').eq('id', user_id).single();
      updates.coins = (p?.coins || 0) + parseInt(coins);
    }
    if (xp) {
      const { data: p } = await client.from('profiles').select('xp').eq('id', user_id).single();
      updates.xp = (p?.xp || 0) + parseInt(xp);
    }
    if (role) updates.role = role;
    const { error } = await client.from('profiles').update(updates).eq('id', user_id);
    if (error) return res.status(400).json({ error: error.message });
    return res.json({ ok: true });
  }

  // ── GRANT PLAN ──
  if (req.method === 'POST' && action === 'grant_plan') {
    const { user_id, plan, duration = 30 } = req.body || {};
    const expires = new Date(Date.now() + parseInt(duration) * 86400000).toISOString();
    await client.from('profiles').update({ plan, plan_expires: expires }).eq('id', user_id);
    await client.from('notifications').insert({ user_id, type: 'success', title: '🎁 Paket Diberikan!', message: `Admin memberikan paket ${plan.toUpperCase()} ${duration} hari!`, icon: plan === 'vip' ? '💎' : '⭐' });
    return res.json({ ok: true });
  }

  // ── ADD COINS ──
  if (req.method === 'POST' && action === 'add_coins') {
    const { user_id, amount } = req.body || {};
    const { data: p } = await client.from('profiles').select('coins').eq('id', user_id).single();
    await client.from('profiles').update({ coins: (p?.coins || 0) + parseInt(amount) }).eq('id', user_id);
    return res.json({ ok: true });
  }

  // ── ADD XP ──
  if (req.method === 'POST' && action === 'add_xp') {
    const { user_id, amount } = req.body || {};
    const { data: p } = await client.from('profiles').select('xp').eq('id', user_id).single();
    const newXp = (p?.xp || 0) + parseInt(amount);
    const newLevel = Math.floor(Math.pow(newXp / 100, 0.7)) + 1;
    await client.from('profiles').update({ xp: newXp, level: Math.min(newLevel, 999) }).eq('id', user_id);
    return res.json({ ok: true });
  }

  // ── BAN USER ──
  if (req.method === 'POST' && action === 'ban_user') {
    const { user_id, banned } = req.body || {};
    await client.from('profiles').update({ is_banned: !!banned }).eq('id', user_id);
    return res.json({ ok: true });
  }

  // ── DELETE USER ──
  if (req.method === 'DELETE' && action === 'delete_user') {
    const user_id = req.query.user_id;
    await client.from('profiles').delete().eq('id', user_id);
    await client.auth.admin.deleteUser(user_id);
    return res.json({ ok: true });
  }

  // ── GET ORDERS ──
  if (req.method === 'GET' && action === 'orders') {
    const status = req.query.status;
    let query = client.from('orders').select('*').order('created_at', { ascending: false }).limit(100);
    if (status) query = query.eq('status', status);
    const { data } = await query;
    return res.json({ orders: data || [] });
  }

  // ── APPROVE ORDER (manual override — biasanya tidak perlu karena auto-aktif) ──
  if (req.method === 'POST' && action === 'approve_order') {
    const { order_id } = req.body || {};
    const { data: order } = await client.from('orders').select('*').eq('order_id', order_id).single();
    if (!order) return res.status(404).json({ error: 'Order tidak ditemukan' });
    if (order.status === 'approved') return res.json({ ok: true, already_approved: true });

    const days = parseInt(order.duration) || 30;
    const expires = new Date(Date.now() + days * 86400000).toISOString();
    const coinsBonus = order.plan === 'vip' ? 750 : 300;
    const xpBonus = order.plan === 'vip' ? 500 : 200;

    await client.from('orders').update({ status: 'approved', activated_at: new Date().toISOString(), expires_at: expires }).eq('order_id', order_id);

    if (order.user_id) {
      const { data: prof } = await client.from('profiles').select('*').eq('id', order.user_id).single();
      await client.from('profiles').update({ plan: order.plan, plan_expires: expires, coins: (prof?.coins || 0) + coinsBonus, xp: (prof?.xp || 0) + xpBonus }).eq('id', order.user_id);
      await client.from('notifications').insert({ user_id: order.user_id, type: 'success', title: '🎉 Pembayaran Disetujui!', message: `Paket ${order.plan.toUpperCase()} ${days} hari telah aktif. +${coinsBonus} koin!`, icon: order.plan === 'vip' ? '💎' : '⭐' });
    }

    if (order.telegram_id) {
      await sendTelegram(order.telegram_id, `✅ *Order Diapprove!*\n\nPaket *${order.plan.toUpperCase()} ${days} Hari* sudah aktif!\nID: \`${order_id}\`\nBonus: +${coinsBonus} koin`);
    }
    return res.json({ ok: true });
  }

  // ── REJECT ORDER ──
  if (req.method === 'POST' && action === 'reject_order') {
    const { order_id, reason } = req.body || {};
    const { data: order } = await client.from('orders').select('*').eq('order_id', order_id).single();
    await client.from('orders').update({ status: 'rejected' }).eq('order_id', order_id);
    if (order?.telegram_id) {
      await sendTelegram(order.telegram_id, `❌ *Order Ditolak*\n\nID: \`${order_id}\`\n${reason ? 'Alasan: ' + reason : 'Hubungi admin untuk info lebih lanjut.'}`);
    }
    return res.json({ ok: true });
  }

  // ── BROADCAST ──
  if (req.method === 'POST' && action === 'broadcast') {
    const { title, message, target = 'all', type = 'info', icon = '📢' } = req.body || {};
    if (!title || !message) return res.status(400).json({ error: 'Judul dan pesan wajib' });

    let query = client.from('profiles').select('id,telegram_id,preferences');
    if (target !== 'all') query = query.eq('plan', target);
    const { data: targets } = await query;

    const inserts = (targets || []).map(t => ({ user_id: t.id, type, title, message, icon, is_read: false }));
    if (inserts.length) await client.from('notifications').insert(inserts);

    // Send Telegram
    let tgSent = 0;
    for (const t of (targets || [])) {
      if (t.telegram_id && t.preferences?.notif?.telegram !== false) {
        await sendTelegram(t.telegram_id, `📢 *${title}*\n\n${message}`);
        tgSent++;
        await new Promise(r => setTimeout(r, 50)); // Rate limit
      }
    }

    return res.json({ ok: true, sent_to: inserts.length, telegram_sent: tgSent });
  }

  return res.status(404).json({ error: 'Action tidak ditemukan: ' + action });
};
