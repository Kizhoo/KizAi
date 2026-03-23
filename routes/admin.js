'use strict';
const { Router } = require('express');
const { sb, verifyToken } = require('../lib/supabase');

const router = Router();

async function getAdmin(client, headers) {
  const user = await verifyToken(client, headers.authorization);
  if (!user || user.role !== 'admin') return null;
  return user;
}

router.all('*', async (req, res) => {
  let client;
  try { client = sb(); } catch (e) { return res.status(500).json({ error: e.message }); }

  const action = req.query.action || '';

  if (action === 'verify') {
    const admin = await getAdmin(client, req.headers);
    if (!admin) return res.status(403).json({ error: 'Bukan admin' });
    return res.json({ ok: true, username: admin.username });
  }

  const admin = await getAdmin(client, req.headers);
  if (!admin) return res.status(403).json({ error: 'Akses ditolak' });

  if (req.method === 'GET' && action === 'stats') {
    const [{ count: users }, { count: orders }, { count: chats }] = await Promise.all([
      client.from('profiles').select('id', { count: 'exact', head: true }),
      client.from('orders').select('id', { count: 'exact', head: true }).eq('status', 'approved'),
      client.from('chat_messages').select('id', { count: 'exact', head: true }),
    ]);
    return res.json({ users: users || 0, orders: orders || 0, chats: chats || 0 });
  }

  if (req.method === 'GET' && action === 'users') {
    const { data } = await client.from('profiles').select('id,username,plan,role,xp,coins,level,is_banned,created_at,last_seen,telegram_id').order('created_at', { ascending: false }).limit(100);
    return res.json({ users: data || [] });
  }

  if (req.method === 'POST' && action === 'edit_user') {
    const { user_id, plan, role, coins, xp } = req.body;
    const upd = { updated_at: new Date().toISOString() };
    if (plan) upd.plan = plan;
    if (role) upd.role = role;
    if (coins !== undefined) upd.coins = parseInt(coins) || 0;
    if (xp !== undefined) upd.xp = parseInt(xp) || 0;
    await client.from('profiles').update(upd).eq('id', user_id);
    return res.json({ ok: true });
  }

  if (req.method === 'POST' && action === 'grant_plan') {
    const { user_id, plan, days } = req.body;
    const expires = new Date(Date.now() + (parseInt(days) || 30) * 86400000).toISOString();
    await client.from('profiles').update({ plan, plan_expires: expires }).eq('id', user_id);
    return res.json({ ok: true });
  }

  if (req.method === 'POST' && action === 'ban_user') {
    await client.from('profiles').update({ is_banned: !!req.body.banned }).eq('id', req.body.user_id);
    return res.json({ ok: true });
  }

  if (req.method === 'DELETE' && action === 'delete_user') {
    await client.from('profiles').delete().eq('id', req.query.user_id);
    await client.auth.admin.deleteUser(req.query.user_id).catch(() => {});
    return res.json({ ok: true });
  }

  if (req.method === 'GET' && action === 'orders') {
    const { data } = await client.from('orders').select('*').order('created_at', { ascending: false }).limit(100);
    return res.json({ orders: data || [] });
  }

  if (req.method === 'POST' && action === 'approve_order') {
    const { data: order } = await client.from('orders').select('*').eq('order_id', req.body.order_id).single();
    if (!order) return res.status(404).json({ error: 'Order tidak ditemukan' });
    const days    = parseInt(order.duration) || 30;
    const expires = new Date(Date.now() + days * 86400000).toISOString();
    await client.from('orders').update({ status: 'approved', activated_at: new Date().toISOString(), expires_at: expires }).eq('order_id', req.body.order_id);
    if (order.user_id) await client.from('profiles').update({ plan: order.plan, plan_expires: expires }).eq('id', order.user_id);
    return res.json({ ok: true });
  }

  if (req.method === 'POST' && action === 'reject_order') {
    await client.from('orders').update({ status: 'rejected' }).eq('order_id', req.body.order_id);
    return res.json({ ok: true });
  }

  if (req.method === 'POST' && action === 'broadcast') {
    const { title, message, target, type = 'info' } = req.body;
    if (!title || !message) return res.status(400).json({ error: 'Title dan message wajib diisi' });
    let q = client.from('profiles').select('id');
    if (target === 'premium') q = q.eq('plan', 'premium');
    else if (target === 'vip') q = q.eq('plan', 'vip');
    else if (target === 'free') q = q.eq('plan', 'free');
    const { data: users } = await q;
    const notifs = (users || []).map(u => ({ user_id: u.id, type, title, message, icon: '📢' }));
    if (notifs.length > 0) await client.from('notifications').insert(notifs);
    return res.json({ ok: true, sent: notifs.length });
  }

  return res.status(404).json({ error: `Action tidak dikenal: "${action}"` });
});

module.exports = router;
