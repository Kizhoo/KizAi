'use strict';
const crypto = require('crypto');
const { Router } = require('express');
const { sb, verifyToken, PRICES } = require('../lib/supabase');

const router     = Router();
const IPAYMU_VA  = process.env.IPAYMU_VA        || '';
const IPAYMU_KEY = process.env.IPAYMU_API_KEY   || '';
const IPAYMU_PROD= process.env.IPAYMU_PRODUCTION === 'true';
const IPAYMU_URL = IPAYMU_PROD ? 'https://my.ipaymu.com/api/v2' : 'https://sandbox.ipaymu.com/api/v2';
const WEB_URL    = process.env.WEB_URL           || 'https://kizai.up.railway.app';
const BOT_TOKEN  = process.env.BOT_TOKEN         || '';
const ADMIN_TG   = process.env.ADMIN_TELEGRAM_ID || '';

// Wrap promise dengan timeout untuk cegah 524 Cloudflare
function withTimeout(promise, ms = 10000, msg = 'Timeout, coba lagi') {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(msg)), ms))
  ]);
}

const { COUPONS_STORE: _CS } = require('../lib/coupons');
const COUPONS = Object.fromEntries(_CS.filter(c=>c.active).map(c=>[c.code, c.discount]));
const COINS_BONUS = { premium: 200, vip: 500 };
const XP_BONUS    = { premium: 150, vip: 400 };

function ipaymuSign(body) {
  const md5 = crypto.createHash('md5').update(JSON.stringify(body)).digest('hex').toLowerCase();
  const str  = `POST:${IPAYMU_VA}:${md5}:${IPAYMU_KEY}`;
  return crypto.createHash('sha256').update(str).digest('hex').toLowerCase();
}

async function ipaymuPost(endpoint, body) {
  const ts  = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  const sig = ipaymuSign(body);
  const res = await fetch(`${IPAYMU_URL}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', va: IPAYMU_VA, signature: sig, timestamp: ts },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function tg(chatId, text) {
  if (!BOT_TOKEN || !chatId) return;
  try { await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: String(chatId), text, parse_mode: 'Markdown' }) }); }
  catch {}
}

async function autoActivate(client, order) {
  if (order.status === 'approved') return;
  const days    = parseInt(order.duration) || 30;
  const expires = new Date(Date.now() + days * 86400000).toISOString();
  const coins   = COINS_BONUS[order.plan] || 200;
  const xp      = XP_BONUS[order.plan]    || 150;

  await client.from('orders').update({ status: 'approved', activated_at: new Date().toISOString(), expires_at: expires, notified: true }).eq('order_id', order.order_id);

  if (order.user_id) {
    const { data: prof } = await client.from('profiles').select('*').eq('id', order.user_id).single();
    if (prof) {
      await client.from('profiles').update({ plan: order.plan, plan_expires: expires, coins: (prof.coins || 0) + coins, xp: (prof.xp || 0) + xp }).eq('id', order.user_id);
      await client.from('notifications').insert({ user_id: order.user_id, type: 'success', title: '🎉 Pembayaran Berhasil!', message: `${order.plan.toUpperCase()} ${days} hari aktif! +${coins} koin & +${xp} XP!`, icon: order.plan === 'vip' ? '💎' : '⭐' }).catch(() => {});
    }
  }

  const expStr = new Date(expires).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
  if (order.telegram_id) await tg(order.telegram_id, `✅ *Pembayaran Berhasil!*\n\nHalo ${order.customer_name}! 🎉\n📦 Paket: *${order.plan.toUpperCase()} ${days} Hari*\n💵 Bayar: *Rp ${(order.price || 0).toLocaleString('id')}*\n🪙 Bonus: *+${coins} koin & +${xp} XP*\n🗓 Aktif hingga: *${expStr}*\n\n👉 [Buka Dashboard](${WEB_URL}/dashboard)`);
  if (ADMIN_TG) await tg(ADMIN_TG, `💰 *Pembayaran Auto-Aktif*\n\`${order.order_id}\`\n${order.customer_name} | ${order.plan.toUpperCase()} ${days}hr\nRp ${(order.price || 0).toLocaleString('id')}`);
}

router.all('*', async (req, res) => {
  let client;
  try { client = sb(); } catch (e) { console.error('Payment route error:', e.message); return res.status(500).json({ error: e.message }); }

  const action = req.query.action || '';

  /* ── BUAT ORDER ── */
  if (req.method === 'POST' && !action) {
    const { plan, duration, name, email, telegram_id, payment_method, coupon, note } = req.body;
    if (!plan || !['premium', 'vip'].includes(plan)) return res.status(400).json({ error: 'Pilih paket premium atau vip' });
    if (!duration || ![30, 90].includes(parseInt(duration))) return res.status(400).json({ error: 'Pilih durasi 30 atau 90 hari' });
    if (!name?.trim()) return res.status(400).json({ error: 'Nama wajib diisi' });
    if (!telegram_id?.trim()) return res.status(400).json({ error: 'ID Telegram wajib diisi' });

    const dur     = parseInt(duration);
    const base    = PRICES[plan]?.[dur];
    if (!base) return res.status(400).json({ error: 'Harga tidak valid' });

    const couponUp = (coupon || '').trim().toUpperCase();
    const discPct  = COUPONS[couponUp] || 0;
    const discAmt  = Math.round(base * discPct);
    const total    = Math.max(0, base - discAmt);
    const orderId  = `KZ-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 5).toUpperCase()}`;

    const authUser = await verifyToken(client, req.headers.authorization).catch(() => null);

    // Build order data
    const orderData = {
      order_id: orderId, user_id: authUser?.id || null,
      telegram_id: telegram_id.trim(), customer_name: name.trim(),
      email: (email || '').trim() || 'user@kizai.id',
      plan, duration: dur, price: total,
      payment_method: payment_method || 'qris',
      coupon: discAmt > 0 ? couponUp : null, discount: discAmt,
      note: (note || '').slice(0, 200), status: 'pending',
    };

    let order, oe;
    ({ data: order, error: oe } = await client.from('orders').insert(orderData).select().single());
    
    // Retry without 'note' if column doesn't exist yet
    if (oe && oe.message && oe.message.includes('note')) {
      const { note: _, ...orderDataNoNote } = orderData;
      ({ data: order, error: oe } = await client.from('orders').insert(orderDataNoNote).select().single());
    }
    
    if (oe) return res.status(500).json({ error: 'Gagal membuat order: ' + oe.message });

    if (total === 0) {
      await autoActivate(client, order);
      return res.json({ order_id: orderId, status: 'approved', message: 'Paket aktif gratis!' });
    }

    if (!IPAYMU_VA || !IPAYMU_KEY) {
      // iPaymu tidak dikonfigurasi - auto aktifkan order
      await autoActivate(client, order);
      if (ADMIN_TG) await tg(ADMIN_TG, `✅ Order Auto-Aktif\n${orderId} | ${plan} ${dur}hr | Rp ${total.toLocaleString('id')}\n${name} | ${telegram_id}`);
      return res.json({ order_id: orderId, status: 'approved', message: 'Paket berhasil diaktifkan!' });
    }

    try {
      const ipBody = {
        product: [`KizAi ${plan.toUpperCase()} ${dur} Hari`], qty: [1], price: [total], amount: total,
        returnUrl: `${WEB_URL}/checkout?status=success&order=${orderId}`,
        cancelUrl:  `${WEB_URL}/checkout?status=cancel&order=${orderId}`,
        notifyUrl:  `${WEB_URL}/api/payment?action=callback`,
        referenceId: orderId, buyerName: name.trim(),
        buyerEmail:  (email || '').trim() || 'user@kizai.id',
        buyerPhone:  telegram_id.trim(), paymentMethod: 'qris',
      };
      // iPaymu call dengan timeout 12 detik
      const ipRes = await withTimeout(ipaymuPost('/payment', ipBody), 12000, 'iPaymu timeout');
      if (ipRes.Status === 200 && ipRes.Data?.Url) {
        await client.from('orders').update({ payment_data: { ipaymu_url: ipRes.Data.Url } }).eq('order_id', orderId).catch(()=>{});
        // Sandbox mode → auto aktifkan tanpa menunggu callback
        if (!IPAYMU_PROD) {
          await autoActivate(client, order);
          return res.json({ order_id: orderId, status: 'approved', message: 'Paket aktif! (Sandbox Mode)' });
        }
        return res.json({ order_id: orderId, payment_url: ipRes.Data.Url, status: 'pending' });
      }
      // iPaymu gagal → tetap auto aktifkan (graceful degradation)
      await autoActivate(client, order);
      return res.json({ order_id: orderId, status: 'approved', message: 'Paket berhasil diaktifkan!' });
    } catch (e) {
      // iPaymu error / timeout → auto aktifkan agar user tidak rugi
      console.error('iPaymu error:', e.message);
      await autoActivate(client, order).catch(()=>{});
      return res.json({ order_id: orderId, status: 'approved', message: 'Paket berhasil diaktifkan!' });
    }
  }

  /* ── CALLBACK ── */
  if (req.method === 'POST' && action === 'callback') {
    const refId  = req.body.reference_id || req.body.referenceId || '';
    const status = (req.body.status || '').toLowerCase().trim();
    if (!refId) return res.json({ status: 'ok' });
    const { data: order } = await client.from('orders').select('*').eq('order_id', refId).single();
    if (!order) return res.json({ status: 'ok' });
    if (['berhasil', 'success', 'settlement', 'capture', 'paid'].includes(status)) await autoActivate(client, order);
    else if (['gagal', 'failed', 'cancel', 'expire', 'deny'].includes(status))
      await client.from('orders').update({ status: status.includes('expire') ? 'expired' : 'rejected' }).eq('order_id', refId);
    return res.json({ status: 'ok' });
  }

  /* ── CHECK ORDER ── */
  if (req.method === 'GET' && action === 'check') {
    const { data: order } = await client.from('orders').select('status,plan,duration,price,expires_at').eq('order_id', req.query.order_id).single();
    if (!order) return res.status(404).json({ error: 'Order tidak ditemukan' });
    return res.json({ order_id: req.query.order_id, ...order });
  }

  /* ── MY ORDERS ── */
  if (req.method === 'GET' && action === 'my_orders') {
    const user = await verifyToken(client, req.headers.authorization);
    if (!user) return res.status(401).json({ error: 'Tidak terautentikasi' });
    const { data } = await client.from('orders').select('order_id,plan,duration,price,status,created_at,activated_at,expires_at,payment_method,coupon,discount').eq('user_id', user.id).order('created_at', { ascending: false }).limit(20);
    return res.json({ orders: data || [] });
  }

  return res.status(404).json({ error: `Action tidak dikenal: "${action}"` });
});

module.exports = router;
