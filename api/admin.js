'use strict';
const { sb, verifyToken, effectivePlan, cors } = require('../lib/supabase');
const axios = require('axios');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  let client;
  try { client = sb(); } catch (e) { return res.status(500).json({ error: e.message }); }

  const user = await verifyToken(req);
  if (!user || user.role !== 'admin')
    return res.status(403).json({ error: 'Forbidden: bukan admin' });

  const action = req.query.action || '';

  // ── STATS ───────────────────────────────────────────────
  if (req.method === 'GET' && action === 'stats') {
    const { data: stats }  = await client.from('admin_stats').select('*').single();
    const { data: plans }  = await client.from('profiles').select('plan').neq('role','admin');
    const planCount = (plans || []).reduce((acc, p) => {
      acc[p.plan] = (acc[p.plan] || 0) + 1; return acc;
    }, {});
    return res.json({ ...(stats || {}), planCount });
  }

  // ── USERS ────────────────────────────────────────────────
  if (req.method === 'GET' && action === 'users') {
    const page   = Math.max(1, parseInt(req.query.page) || 1);
    const search = req.query.search || '';
    let query = client.from('profiles')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range((page - 1) * 20, page * 20 - 1);
    if (search) query = query.or(`username.ilike.%${search}%`);
    const { data, count } = await query;
    return res.json({ users: data || [], total: count || 0 });
  }

  // ── ORDERS ───────────────────────────────────────────────
  if (req.method === 'GET' && action === 'orders') {
    const page   = Math.max(1, parseInt(req.query.page) || 1);
    const status = req.query.status || '';
    let query = client.from('orders')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range((page - 1) * 50, page * 50 - 1);
    if (status) query = query.eq('status', status);
    const { data, count } = await query;
    return res.json({ orders: data || [], total: count || 0 });
  }

  // ── APPROVE / REJECT ORDER ───────────────────────────────
  if (req.method === 'PUT' && action === 'order') {
    const { order_id, status } = req.body || {};
    if (!order_id || !status) return res.status(400).json({ error: 'order_id dan status wajib' });
    const { data: order } = await client.from('orders').select('*').eq('order_id', order_id).single();
    if (!order) return res.status(404).json({ error: 'Order tidak ditemukan' });

    if (status === 'approved' && order.status !== 'approved') {
      // Use the full activateSub logic from payment.js via inline
      const days    = parseInt(order.duration) || 30;
      const expires = new Date(Date.now() + days * 86400000).toISOString();
      const bonusCoins = order.plan === 'vip' ? 500 : 200;

      await client.from('orders').update({
        status: 'approved',
        activated_at: new Date().toISOString(),
        expires_at: expires,
      }).eq('order_id', order_id);

      if (order.user_id) {
        const { data: u } = await client.from('profiles').select('*').eq('id', order.user_id).single();
        await client.from('profiles').update({
          plan: order.plan,
          plan_expires: expires,
          coins: (u?.coins || 0) + bonusCoins,
          xp:    (u?.xp || 0) + 100,
        }).eq('id', order.user_id);
        await client.from('notifications').insert({
          user_id: order.user_id,
          type:    'success',
          title:   '🎉 Pembayaran Disetujui Admin!',
          message: `Paket ${order.plan.toUpperCase()} ${days} hari aktif. Bonus ${bonusCoins} koin!`,
          icon:    order.plan === 'vip' ? '💎' : '⭐',
        });
      }

      // Telegram notify user
      const BOT = process.env.BOT_TOKEN;
      const tgId = order.telegram_id;
      if (BOT && tgId) {
        axios.post(`https://api.telegram.org/bot${BOT}/sendMessage`, {
          chat_id: String(tgId),
          text: `✅ *Pembayaran Disetujui!*\n\nPaket *${order.plan.toUpperCase()} ${days} hari* sudah aktif!\nID Order: \`${order_id}\``,
          parse_mode: 'Markdown',
        }).catch(() => {});
      }
    } else {
      await client.from('orders').update({ status }).eq('order_id', order_id);
    }
    return res.json({ message: `Order diupdate ke ${status}` });
  }

  // ── UPDATE USER PLAN (manual) ────────────────────────────
  if (req.method === 'PUT' && action === 'user-plan') {
    const { user_id, plan, duration } = req.body || {};
    if (!user_id || !plan) return res.status(400).json({ error: 'user_id dan plan wajib' });
    const updates = { plan };
    if (plan !== 'free' && duration) updates.plan_expires = new Date(Date.now() + duration * 86400000).toISOString();
    else if (plan === 'free') updates.plan_expires = null;
    await client.from('profiles').update(updates).eq('id', user_id);
    await client.from('notifications').insert({
      user_id,
      type:    'info',
      title:   '📋 Plan Diubah Admin',
      message: `Plan kamu diubah ke ${plan.toUpperCase()}${duration ? ` (${duration} hari)` : ''}`,
    }).catch(() => {});
    return res.json({ message: 'Plan berhasil diupdate' });
  }

  // ── DELETE USER ──────────────────────────────────────────
  if (req.method === 'DELETE' && action === 'user') {
    const { user_id } = req.body || {};
    if (!user_id) return res.status(400).json({ error: 'user_id wajib' });
    await client.auth.admin.deleteUser(user_id).catch(() => {});
    return res.json({ message: 'User dihapus' });
  }

  // ── BROADCAST TELEGRAM ───────────────────────────────────
  if (req.method === 'POST' && action === 'broadcast') {
    const { message, plan_filter, channel_id } = req.body || {};
    if (!message) return res.status(400).json({ error: 'Pesan wajib diisi' });
    const BOT = process.env.BOT_TOKEN;
    if (!BOT) return res.status(400).json({ error: 'BOT_TOKEN belum dikonfigurasi di environment' });

    // Kirim ke channel/group tertentu
    if (channel_id) {
      try {
        await axios.post(`https://api.telegram.org/bot${BOT}/sendMessage`, {
          chat_id: channel_id, text: message, parse_mode: 'Markdown',
        });
        return res.json({ sent: 1, total: 1, mode: 'channel' });
      } catch (e) {
        return res.status(500).json({ error: 'Gagal kirim ke channel: ' + e.message });
      }
    }

    // Kirim ke user yang punya telegram_id
    let query = client.from('profiles')
      .select('telegram_id')
      .not('telegram_id', 'is', null)
      .neq('telegram_id', '');
    if (plan_filter && plan_filter !== 'all') query = query.eq('plan', plan_filter);
    const { data: users } = await query;

    let sent = 0;
    const total = (users || []).length;
    for (const u of (users || [])) {
      if (!u.telegram_id) continue;
      try {
        await axios.post(`https://api.telegram.org/bot${BOT}/sendMessage`, {
          chat_id: String(u.telegram_id), text: message, parse_mode: 'Markdown',
        }, { timeout: 5000 });
        sent++;
      } catch {}
      await new Promise(r => setTimeout(r, 60)); // ~16 req/sec Telegram rate limit
    }
    return res.json({ sent, total, mode: 'users' });
  }

  // ── ANNOUNCEMENT ─────────────────────────────────────────
  if (req.method === 'POST' && action === 'announce') {
    const { title, content, type } = req.body || {};
    if (!title || !content) return res.status(400).json({ error: 'title dan content wajib' });
    const { data } = await client.from('announcements').insert({
      title, content, type: type || 'info', created_by: user.id,
    }).select().single();
    return res.json({ announcement: data });
  }

  res.status(404).json({ error: 'Endpoint tidak ditemukan' });
};
