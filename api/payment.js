'use strict';
const { sb, verifyToken, cors } = require('../lib/supabase');
const axios = require('axios');

const MT_SRV  = process.env.MIDTRANS_SERVER_KEY || '';
const MT_PROD = process.env.MIDTRANS_PRODUCTION === 'true';
const MT_SNAP = MT_PROD ? 'https://app.midtrans.com/snap/v1' : 'https://app.sandbox.midtrans.com/snap/v1';
const PRICES  = { premium: { 30: 15000, 90: 35000 }, vip: { 30: 25000, 90: 60000 } };
const COUPONS = { KIZAI10: .1, HEMAT20: .2, PREMIUM50: .5, FREE100: 1 };

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const client = sb();

  // Create order
  if (req.method === 'POST' && !req.query.action) {
    const { plan, duration, name, email, telegram_id, payment_method, coupon } = req.body || {};
    if (!plan || !duration) return res.status(400).json({ error: 'Data tidak lengkap' });
    const user = await verifyToken(req);
    const base = PRICES[plan]?.[parseInt(duration)];
    if (!base) return res.status(400).json({ error: 'Paket tidak valid' });
    const c = (coupon || '').toUpperCase();
    const discRate = COUPONS[c] || 0;
    const disc = Math.round(base * discRate);
    const total = Math.max(0, base - disc);
    const orderId = 'KZ-' + Date.now();

    const { data: order, error: oErr } = await client.from('orders').insert({
      order_id: orderId, user_id: user?.id || null,
      telegram_id: telegram_id || user?.telegram_id || '',
      customer_name: name || user?.username || 'User',
      email: email || user?.email || 'user@kizai.id',
      plan, duration: parseInt(duration), price: total,
      payment_method: payment_method || 'qris',
      coupon: c || null, discount: disc,
    }).select().single();
    if (oErr) return res.status(500).json({ error: oErr.message });

    if (total === 0) { await activateSub(client, order, user); return res.json({ demo: true, free: true, order_id: orderId }); }
    if (!MT_SRV) { notifyOwner(order); return res.json({ demo: true, order_id: orderId }); }

    try {
      const pmMap = { qris: ['qris'], gopay: ['gopay'], ovo: ['shopeepay'], dana: ['dana'], bca: ['bca_va'], bni: ['bni_va'], bri: ['bri_epay'], mandiri: ['echannel'], alfamart: ['alfamart'], indomaret: ['indomaret'] };
      const auth = Buffer.from(MT_SRV + ':').toString('base64');
      const snap = await axios.post(`${MT_SNAP}/transactions`, {
        transaction_details: { order_id: orderId, gross_amount: total },
        customer_details: { first_name: order.customer_name, email: order.email },
        item_details: [{ id: plan, price: total, quantity: 1, name: `KizAi ${plan.toUpperCase()} ${duration} Hari` }],
        enabled_payments: pmMap[payment_method] || [],
        callbacks: { finish: `${process.env.WEB_URL || ''}/checkout.html?oid=${orderId}` },
      }, { headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' }, timeout: 15000 });
      await client.from('orders').update({ snap_token: snap.data.token }).eq('order_id', orderId);
      return res.json({ snap_token: snap.data.token, order_id: orderId });
    } catch (e) {
      return res.status(500).json({ error: 'Midtrans error: ' + (e.response?.data?.error_messages?.[0] || e.message) });
    }
  }

  // Midtrans webhook
  if (req.method === 'POST' && req.query.action === 'webhook') {
    const { order_id, transaction_status, fraud_status } = req.body || {};
    if (!order_id) return res.status(400).json({ error: 'no order_id' });
    let status = 'pending';
    if ((transaction_status === 'capture' && fraud_status === 'accept') || transaction_status === 'settlement') status = 'approved';
    else if (['cancel','deny','expire'].includes(transaction_status)) status = 'rejected';
    if (status !== 'pending') {
      const { data: order } = await client.from('orders').select('*').eq('order_id', order_id).single();
      if (order) {
        await client.from('orders').update({ status }).eq('order_id', order_id);
        if (status === 'approved') {
          const user = order.user_id ? await client.from('profiles').select('*').eq('id', order.user_id).single().then(r => r.data) : null;
          await activateSub(client, order, user);
          notifyUser(order);
        }
      }
    }
    return res.json({ status: 'OK' });
  }

  // Get order status
  if (req.method === 'GET' && req.query.oid) {
    const { data } = await client.from('orders').select('order_id,plan,duration,price,status,created_at').eq('order_id', req.query.oid).single();
    if (!data) return res.status(404).json({ error: 'Order tidak ditemukan' });
    return res.json(data);
  }

  res.status(404).json({ error: 'Not found' });
};

async function activateSub(client, order, user) {
  const days = parseInt(order.duration) || 30;
  const expires = new Date(Date.now() + days * 86400000).toISOString();
  if (user) {
    await client.from('profiles').update({ plan: order.plan, plan_expires: expires, coins: (user.coins || 0) + (order.plan === 'vip' ? 500 : 200), xp: (user.xp || 0) + 100 }).eq('id', user.id);
    await client.from('notifications').insert({ user_id: user.id, type: 'success', title: '🎉 Pembayaran Berhasil!', message: `Paket ${order.plan.toUpperCase()} ${days} hari aktif sekarang!`, icon: order.plan === 'vip' ? '💎' : '⭐' });
  }
  await client.from('orders').update({ status: 'approved', activated_at: new Date().toISOString(), expires_at: expires }).eq('order_id', order.order_id);
}

function notifyOwner(order) {
  if (!process.env.BOT_TOKEN || !process.env.OWNER_ID) return;
  const msg = `🛒 *ORDER BARU!*\nID: \`${order.order_id}\`\nUser: ${order.customer_name}\nPaket: *${order.plan.toUpperCase()} ${order.duration}hr*\nHarga: Rp ${order.price.toLocaleString('id')}\nBayar: ${order.payment_method}`;
  axios.post(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`, { chat_id: process.env.OWNER_ID, text: msg, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '✅ Approve', callback_data: `approve_${order.order_id}` }]] } }).catch(() => {});
}

function notifyUser(order) {
  if (!process.env.BOT_TOKEN || !order.telegram_id) return;
  const msg = `✅ *Pembayaran Berhasil!*\n\nPaket *${order.plan.toUpperCase()} ${order.duration} hari* sudah aktif!\n\nID Order: \`${order.order_id}\``;
  axios.post(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`, { chat_id: order.telegram_id, text: msg, parse_mode: 'Markdown' }).catch(() => {});
}
