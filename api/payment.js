'use strict';
const { sb, verifyToken, cors } = require('../lib/supabase');
const axios = require('axios');

const MT_SRV  = process.env.MIDTRANS_SERVER_KEY || '';
const MT_CLI  = process.env.MIDTRANS_CLIENT_KEY || '';
const MT_PROD = process.env.MIDTRANS_PRODUCTION === 'true';
const MT_SNAP = MT_PROD
  ? 'https://app.midtrans.com/snap/v1'
  : 'https://app.sandbox.midtrans.com/snap/v1';
const MT_API  = MT_PROD
  ? 'https://api.midtrans.com/v2'
  : 'https://api.sandbox.midtrans.com/v2';
const WEB_URL = process.env.WEB_URL || 'https://kizai.vercel.app';

const PRICES  = { premium: { 30: 15000, 90: 35000 }, vip: { 30: 25000, 90: 60000 } };
const COUPONS = { KIZAI10: .1, HEMAT20: .2, PREMIUM50: .5, FREE100: 1 };

// ── TELEGRAM HELPER ─────────────────────────────────────────
async function sendTelegram(chatId, text) {
  const BOT = process.env.BOT_TOKEN;
  if (!BOT || !chatId) return;
  try {
    await axios.post(`https://api.telegram.org/bot${BOT}/sendMessage`, {
      chat_id: String(chatId),
      text,
      parse_mode: 'Markdown',
    }, { timeout: 8000 });
  } catch (e) {
    console.error('Telegram error:', e.message);
  }
}

// ── ACTIVATE SUBSCRIPTION ────────────────────────────────────
async function activateSub(client, order, user) {
  const days    = parseInt(order.duration) || 30;
  const expires = new Date(Date.now() + days * 86400000).toISOString();
  const bonusCoins = order.plan === 'vip' ? 500 : 200;

  // Update order
  await client.from('orders').update({
    status: 'approved',
    activated_at: new Date().toISOString(),
    expires_at: expires,
    notified: false,
  }).eq('order_id', order.order_id);

  // Update user profile
  if (user) {
    await client.from('profiles').update({
      plan: order.plan,
      plan_expires: expires,
      coins: (user.coins || 0) + bonusCoins,
      xp:    (user.xp || 0) + 100,
    }).eq('id', user.id);

    // In-app notification
    await client.from('notifications').insert({
      user_id: user.id,
      type:    'success',
      title:   '🎉 Pembayaran Berhasil!',
      message: `Paket ${order.plan.toUpperCase()} ${days} hari sudah aktif! Bonus ${bonusCoins} koin ditambahkan.`,
      icon:    order.plan === 'vip' ? '💎' : '⭐',
    });
  }

  // Telegram notification ke user
  const tgId = order.telegram_id || user?.telegram_id;
  if (tgId) {
    const msg =
`✅ *Pembayaran Berhasil!*

Terima kasih ${order.customer_name}! 🎉

📦 Paket: *${order.plan.toUpperCase()} ${days} Hari*
💰 Harga: Rp ${(order.price || 0).toLocaleString('id')}
🪙 Bonus: +${bonusCoins} koin
🗓 Aktif hingga: ${new Date(expires).toLocaleDateString('id-ID', { day:'numeric', month:'long', year:'numeric' })}

ID Order: \`${order.order_id}\`

Selamat menikmati fitur premium KizAi! 🚀`;
    await sendTelegram(tgId, msg);
  }

  // Telegram notification ke owner/channel
  const OWNER_ID   = process.env.OWNER_ID;
  const CHANNEL_ID = process.env.CHANNEL_ID; // bisa @channelname atau -100xxxx
  const ownerMsg =
`💰 *ORDER BERHASIL!*

🛒 Order ID: \`${order.order_id}\`
👤 User: ${order.customer_name}
📧 Email: ${order.email}
📦 Paket: *${order.plan.toUpperCase()} ${days} Hari*
💵 Nominal: *Rp ${(order.price || 0).toLocaleString('id')}*
💳 Metode: ${order.payment_method || '-'}
${order.coupon ? `🎟 Kupon: ${order.coupon} (-Rp ${(order.discount||0).toLocaleString('id')})` : ''}

✅ Otomatis diaktifkan!`;

  if (OWNER_ID)   await sendTelegram(OWNER_ID, ownerMsg);
  if (CHANNEL_ID) await sendTelegram(CHANNEL_ID, ownerMsg);

  // Mark as notified
  await client.from('orders').update({ notified: true }).eq('order_id', order.order_id);
}

// ─────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  let client;
  try { client = sb(); } catch (e) { return res.status(500).json({ error: e.message }); }

  // ── CREATE ORDER ──────────────────────────────────────────
  if (req.method === 'POST' && !req.query.action) {
    const { plan, duration, name, email, telegram_id, payment_method, coupon } = req.body || {};
    if (!plan || !duration) return res.status(400).json({ error: 'Data tidak lengkap' });

    const user = await verifyToken(req);
    const base = PRICES[plan]?.[parseInt(duration)];
    if (!base) return res.status(400).json({ error: 'Paket tidak valid' });

    const c        = (coupon || '').toUpperCase().trim();
    const discRate = COUPONS[c] || 0;
    const disc     = Math.round(base * discRate);
    const total    = Math.max(0, base - disc);
    const orderId  = 'KZ-' + Date.now();

    const { data: order, error: oErr } = await client.from('orders').insert({
      order_id:       orderId,
      user_id:        user?.id || null,
      telegram_id:    telegram_id || user?.telegram_id || '',
      customer_name:  name || user?.username || 'User',
      email:          email || user?.email || '',
      plan,
      duration:       parseInt(duration),
      price:          total,
      payment_method: payment_method || 'qris',
      coupon:         c || null,
      discount:       disc,
      status:         'pending',
    }).select().single();

    if (oErr) return res.status(500).json({ error: oErr.message });

    // Free (100% coupon)
    if (total === 0) {
      await activateSub(client, order, user);
      return res.json({ free: true, order_id: orderId, message: 'Paket berhasil diaktifkan gratis!' });
    }

    // No Midtrans configured → demo mode
    if (!MT_SRV) {
      // Still notify owner via Telegram
      const OWNER_ID = process.env.OWNER_ID;
      if (OWNER_ID) {
        await sendTelegram(OWNER_ID,
`🛒 *ORDER BARU (Demo)!*
ID: \`${orderId}\`
User: ${order.customer_name}
Paket: *${plan.toUpperCase()} ${duration}hr*
Harga: Rp ${total.toLocaleString('id')}
Bayar: ${payment_method || 'qris'}`
        );
      }
      return res.json({ demo: true, order_id: orderId, message: 'Order diterima. Hubungi admin untuk aktivasi.' });
    }

    // Real Midtrans
    try {
      const pmMap = {
        qris:      ['qris'],
        gopay:     ['gopay'],
        ovo:       ['shopeepay'],
        dana:      ['dana'],
        bca:       ['bca_va'],
        bni:       ['bni_va'],
        bri:       ['bri_epay'],
        mandiri:   ['echannel'],
        alfamart:  ['alfamart'],
        indomaret: ['indomaret'],
      };
      const auth = Buffer.from(MT_SRV + ':').toString('base64');
      const snap = await axios.post(`${MT_SNAP}/transactions`, {
        transaction_details: { order_id: orderId, gross_amount: total },
        customer_details:    { first_name: order.customer_name, email: order.email || 'user@kizai.id' },
        item_details: [{ id: plan, price: total, quantity: 1, name: `KizAi ${plan.toUpperCase()} ${duration} Hari` }],
        enabled_payments: pmMap[payment_method] || ['qris','gopay','bca_va','bni_va'],
        callbacks: { finish: `${WEB_URL}/checkout.html?oid=${orderId}` },
      }, {
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
        timeout: 20000,
      });

      await client.from('orders').update({
        snap_token:        snap.data.token,
        snap_redirect_url: snap.data.redirect_url,
      }).eq('order_id', orderId);

      return res.json({
        snap_token:        snap.data.token,
        snap_redirect_url: snap.data.redirect_url,
        order_id:          orderId,
        client_key:        MT_CLI,
        is_production:     MT_PROD,
      });
    } catch (e) {
      const errMsg = e.response?.data?.error_messages?.[0] || e.message;
      return res.status(500).json({ error: 'Midtrans error: ' + errMsg });
    }
  }

  // ── MIDTRANS WEBHOOK ─────────────────────────────────────
  if (req.method === 'POST' && req.query.action === 'webhook') {
    const { order_id, transaction_status, fraud_status } = req.body || {};
    if (!order_id) return res.status(400).json({ error: 'no order_id' });

    let newStatus = null;
    if ((transaction_status === 'capture' && fraud_status === 'accept') || transaction_status === 'settlement') {
      newStatus = 'approved';
    } else if (['cancel','deny','expire'].includes(transaction_status)) {
      newStatus = 'rejected';
    }

    if (newStatus) {
      const { data: order } = await client.from('orders').select('*').eq('order_id', order_id).single();
      if (order && order.status !== 'approved') {
        if (newStatus === 'approved') {
          const user = order.user_id
            ? (await client.from('profiles').select('*').eq('id', order.user_id).single()).data
            : null;
          await activateSub(client, order, user);
        } else {
          await client.from('orders').update({ status: newStatus }).eq('order_id', order_id);
        }
      }
    }
    return res.json({ status: 'OK' });
  }

  // ── GET ORDER STATUS ─────────────────────────────────────
  if (req.method === 'GET' && req.query.oid) {
    const { data } = await client.from('orders')
      .select('order_id,plan,duration,price,status,created_at,activated_at,expires_at')
      .eq('order_id', req.query.oid).single();
    if (!data) return res.status(404).json({ error: 'Order tidak ditemukan' });

    // If pending, optionally verify with Midtrans
    if (data.status === 'pending' && MT_SRV) {
      try {
        const auth = Buffer.from(MT_SRV + ':').toString('base64');
        const r = await axios.get(`${MT_API}/${req.query.oid}/status`, {
          headers: { Authorization: `Basic ${auth}` }, timeout: 10000,
        });
        const ts = r.data.transaction_status;
        const fs = r.data.fraud_status;
        if ((ts === 'capture' && fs === 'accept') || ts === 'settlement') {
          const { data: order } = await client.from('orders').select('*').eq('order_id', req.query.oid).single();
          if (order && order.status !== 'approved') {
            const user = order.user_id
              ? (await client.from('profiles').select('*').eq('id', order.user_id).single()).data
              : null;
            await activateSub(client, order, user);
            return res.json({ ...data, status: 'approved' });
          }
        }
      } catch {}
    }
    return res.json(data);
  }

  // ── MANUAL VERIFY ───────────────────────────────────────
  if (req.method === 'POST' && req.query.action === 'verify') {
    const user = await verifyToken(req);
    const { order_id } = req.body || {};
    if (!order_id) return res.status(400).json({ error: 'order_id wajib' });
    if (!MT_SRV) return res.status(400).json({ error: 'Midtrans tidak dikonfigurasi' });
    try {
      const auth = Buffer.from(MT_SRV + ':').toString('base64');
      const r = await axios.get(`${MT_API}/${order_id}/status`, {
        headers: { Authorization: `Basic ${auth}` }, timeout: 10000,
      });
      const ts = r.data.transaction_status;
      const fs = r.data.fraud_status;
      if ((ts === 'capture' && fs === 'accept') || ts === 'settlement') {
        const { data: order } = await client.from('orders').select('*').eq('order_id', order_id).single();
        if (order && order.status !== 'approved') {
          const u = order.user_id
            ? (await client.from('profiles').select('*').eq('id', order.user_id).single()).data
            : user;
          await activateSub(client, order, u);
        }
        return res.json({ status: 'approved' });
      }
      return res.json({ status: ts });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  res.status(404).json({ error: 'Not found' });
};
