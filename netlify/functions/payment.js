'use strict';
const crypto = require('crypto');
const { sb, verifyToken, PRICES, ok, err, preflight, parseEvent } = require('./utils/supabase');

const IPAYMU_VA   = process.env.IPAYMU_VA        || '';
const IPAYMU_KEY  = process.env.IPAYMU_API_KEY   || '';
const IPAYMU_PROD = process.env.IPAYMU_PRODUCTION === 'true';
const IPAYMU_URL  = IPAYMU_PROD ? 'https://my.ipaymu.com/api/v2' : 'https://sandbox.ipaymu.com/api/v2';
const WEB_URL     = process.env.WEB_URL           || 'https://kizai.netlify.app';
const BOT_TOKEN   = process.env.BOT_TOKEN         || '';
const ADMIN_TG    = process.env.ADMIN_TELEGRAM_ID || '';

/* Harga baru (lebih terjangkau) */
const COUPONS = { KIZAI10: .10, HEMAT20: .20, VIP30: .30, PREMIUM50: .50, NEWUSER25: .25, FREE100: 1 };
const COINS_BONUS = { premium: 200, vip: 500 };
const XP_BONUS    = { premium: 150, vip: 400 };

function ipaymuSign(body) {
  const md5 = crypto.createHash('md5').update(JSON.stringify(body)).digest('hex').toLowerCase();
  const str  = `POST:${IPAYMU_VA}:${md5}:${IPAYMU_KEY}`;
  return crypto.createHash('sha256').update(str).digest('hex').toLowerCase();
}

async function ipaymuPost(endpoint, body) {
  const ts  = new Date().toISOString().replace(/[-:T.Z]/g,'').slice(0,14);
  const sig = ipaymuSign(body);
  const res = await fetch(`${IPAYMU_URL}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type':'application/json', va: IPAYMU_VA, signature: sig, timestamp: ts },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function tg(chatId, text) {
  if (!BOT_TOKEN || !chatId) return;
  try { await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ chat_id: String(chatId), text, parse_mode:'Markdown' }) }); }
  catch {}
}

async function autoActivate(client, order) {
  if (order.status === 'approved') return;
  const days    = parseInt(order.duration) || 30;
  const expires = new Date(Date.now() + days * 86400000).toISOString();
  const coins   = COINS_BONUS[order.plan] || 200;
  const xp      = XP_BONUS[order.plan]    || 150;

  await client.from('orders').update({ status:'approved', activated_at: new Date().toISOString(), expires_at: expires, notified: true }).eq('order_id', order.order_id);

  if (order.user_id) {
    const { data: prof } = await client.from('profiles').select('*').eq('id', order.user_id).single();
    if (prof) {
      await client.from('profiles').update({ plan: order.plan, plan_expires: expires, coins: (prof.coins||0)+coins, xp: (prof.xp||0)+xp }).eq('id', order.user_id);
      await client.from('notifications').insert({ user_id: order.user_id, type:'success', title:'🎉 Pembayaran Berhasil!', message:`${order.plan.toUpperCase()} ${days} hari aktif! +${coins} koin & +${xp} XP!`, icon: order.plan==='vip'?'💎':'⭐' }).catch(()=>{});
    }
  }

  const tgId = order.telegram_id;
  const expStr = new Date(expires).toLocaleDateString('id-ID',{day:'numeric',month:'long',year:'numeric'});
  if (tgId) await tg(tgId, `✅ *Pembayaran Berhasil!*\n\nHalo ${order.customer_name}! 🎉\n📦 Paket: *${order.plan.toUpperCase()} ${days} Hari*\n💵 Bayar: *Rp ${(order.price||0).toLocaleString('id')}*\n🪙 Bonus: *+${coins} koin & +${xp} XP*\n🗓 Aktif hingga: *${expStr}*\n\n👉 [Buka Dashboard](${WEB_URL}/dashboard)`);
  if (ADMIN_TG) await tg(ADMIN_TG, `💰 *Pembayaran Auto-Aktif*\n\`${order.order_id}\`\n${order.customer_name} | ${order.plan.toUpperCase()} ${days}hr\nRp ${(order.price||0).toLocaleString('id')}`);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();

  let client;
  try { client = sb(); } catch (e) { return err(e.message, 500); }

  const { method, query, body, headers } = parseEvent(event);
  const action = query.action || '';

  /* ── BUAT ORDER ── */
  if (method === 'POST' && !action) {
    const { plan, duration, name, email, telegram_id, payment_method, coupon, note } = body;
    if (!plan || !['premium','vip'].includes(plan)) return err('Pilih paket premium atau vip');
    if (!duration || ![30,90].includes(parseInt(duration))) return err('Pilih durasi 30 atau 90 hari');
    if (!name?.trim()) return err('Nama wajib diisi');
    if (!telegram_id?.trim()) return err('ID Telegram wajib diisi');

    const dur  = parseInt(duration);
    const base = PRICES[plan]?.[dur];
    if (!base) return err('Harga tidak valid');

    const couponUp = (coupon||'').trim().toUpperCase();
    const discPct  = COUPONS[couponUp] || 0;
    const discAmt  = Math.round(base * discPct);
    const total    = Math.max(0, base - discAmt);
    const orderId  = `KZ-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2,5).toUpperCase()}`;

    const authUser = await verifyToken(client, headers.authorization).catch(() => null);

    const { data: order, error: oe } = await client.from('orders').insert({
      order_id: orderId, user_id: authUser?.id || null,
      telegram_id: telegram_id.trim(), customer_name: name.trim(),
      email: (email||'').trim() || 'user@kizai.id',
      plan, duration: dur, price: total,
      payment_method: payment_method || 'qris',
      coupon: discAmt > 0 ? couponUp : null, discount: discAmt,
      note: (note||'').slice(0,200), status: 'pending',
    }).select().single();
    if (oe) return err('Gagal membuat order: ' + oe.message, 500);

    if (total === 0) {
      await autoActivate(client, order);
      return ok({ order_id: orderId, status: 'approved', message: 'Paket aktif gratis!' });
    }

    if (!IPAYMU_VA || !IPAYMU_KEY) {
      if (ADMIN_TG) await tg(ADMIN_TG, `🆕 Order baru\n${orderId} | ${plan} ${dur}hr | Rp ${total.toLocaleString('id')}\n${name} | ${telegram_id}`);
      return ok({ order_id: orderId, status: 'pending', message: `Order dibuat. ID: ${orderId}` });
    }

    try {
      const ipBody = {
        product: [`KizAi ${plan.toUpperCase()} ${dur} Hari`], qty:[1], price:[total], amount: total,
        returnUrl: `${WEB_URL}/checkout?status=success&order=${orderId}`,
        cancelUrl:  `${WEB_URL}/checkout?status=cancel&order=${orderId}`,
        notifyUrl:  `${WEB_URL}/api/payment?action=callback`,
        referenceId: orderId, buyerName: name.trim(),
        buyerEmail: (email||'').trim() || 'user@kizai.id',
        buyerPhone: telegram_id.trim(), paymentMethod: 'qris',
      };
      const ipRes = await ipaymuPost('/payment', ipBody);
      if (ipRes.Status === 200 && ipRes.Data?.Url) {
        await client.from('orders').update({ payment_data: { ipaymu_url: ipRes.Data.Url, ipaymu_session: ipRes.Data.SessionId } }).eq('order_id', orderId);
        return ok({ order_id: orderId, payment_url: ipRes.Data.Url, status: 'pending' });
      }
      return err(ipRes.Message || 'Gagal membuat link pembayaran', 502);
    } catch (e) { return err('iPaymu error: ' + e.message, 500); }
  }

  /* ── CALLBACK iPaymu ── */
  if (method === 'POST' && action === 'callback') {
    const refId  = body.reference_id || body.referenceId || '';
    const status = (body.status || '').toLowerCase().trim();
    if (!refId) return ok({ status: 'ok' });

    const { data: order } = await client.from('orders').select('*').eq('order_id', refId).single();
    if (!order) return ok({ status: 'ok' });

    const isOk = ['berhasil','success','settlement','capture','paid'].includes(status);
    if (isOk) { await autoActivate(client, order); }
    else if (['gagal','failed','cancel','expire','deny'].includes(status)) {
      await client.from('orders').update({ status: status.includes('expire')?'expired':'rejected' }).eq('order_id', refId);
    }
    return ok({ status: 'ok' });
  }

  /* ── CHECK ORDER ── */
  if (method === 'GET' && action === 'check') {
    const { data: order } = await client.from('orders').select('status,plan,duration,price,expires_at').eq('order_id', query.order_id).single();
    if (!order) return err('Order tidak ditemukan', 404);
    return ok({ order_id: query.order_id, ...order });
  }

  /* ── MY ORDERS ── */
  if (method === 'GET' && action === 'my_orders') {
    const user = await verifyToken(client, headers.authorization);
    if (!user) return err('Tidak terautentikasi', 401);
    const { data } = await client.from('orders').select('order_id,plan,duration,price,status,created_at,activated_at,expires_at,payment_method,coupon,discount').eq('user_id', user.id).order('created_at', { ascending: false }).limit(20);
    return ok({ orders: data || [] });
  }

  return err(`Action tidak dikenal: "${action}"`, 404);
};
