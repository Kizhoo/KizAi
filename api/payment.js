'use strict';
const { sb, verifyToken, cors } = require('../lib/supabase');
const fetch  = require('node-fetch');
const crypto = require('crypto');

/* ═══════════════════════════════════════════════════════════════
   iPaymu — Payment Gateway Indonesia
   https://ipaymu.com/api-payment/

   Environment Variables (set di Vercel Dashboard):
   ─────────────────────────────────────────────────
   IPAYMU_VA          → Virtual Account iPaymu kamu
                         Contoh: 0000007xxxxxxxxx
   IPAYMU_API_KEY     → API Key dari dashboard iPaymu
   IPAYMU_PRODUCTION  → "true" untuk live, kosongkan untuk sandbox
   WEB_URL            → https://domainmu.vercel.app
   BOT_TOKEN          → Token bot Telegram
   ADMIN_TELEGRAM_ID  → ID Telegram admin (untuk notif)
   ═══════════════════════════════════════════════════════════════ */
const IPAYMU_VA   = process.env.IPAYMU_VA        || '';
const IPAYMU_KEY  = process.env.IPAYMU_API_KEY   || '';
const IPAYMU_PROD = process.env.IPAYMU_PRODUCTION === 'true';
const IPAYMU_URL  = IPAYMU_PROD
  ? 'https://my.ipaymu.com/api/v2'
  : 'https://sandbox.ipaymu.com/api/v2';

const WEB_URL   = process.env.WEB_URL            || 'https://kizai.vercel.app';
const BOT_TOKEN = process.env.BOT_TOKEN          || '';
const ADMIN_TG  = process.env.ADMIN_TELEGRAM_ID  || '';

/* ── HARGA — Premium SELALU < VIP ── */
const PRICES = {
  premium: { 30: 29000,  90: 69000  },
  vip:     { 30: 59000,  90: 139000 },
};
const COUPONS = {
  KIZAI10:   0.10,
  HEMAT20:   0.20,
  VIP30:     0.30,
  PREMIUM50: 0.50,
  NEWUSER25: 0.25,
  FREE100:   1.00,
};
const COINS_BONUS = { premium: 300, vip: 750 };
const XP_BONUS    = { premium: 200, vip: 500 };

/* ═══════════════════════════════════════════════════════════════
   iPaymu Signature
   SHA256( "POST:{VA}:{MD5(bodyJSON)}:{APIKEY}" )
   ═══════════════════════════════════════════════════════════════ */
function ipaymuSign(body) {
  const md5body = crypto.createHash('md5')
    .update(JSON.stringify(body)).digest('hex').toLowerCase();
  const str = `POST:${IPAYMU_VA}:${md5body}:${IPAYMU_KEY}`;
  return crypto.createHash('sha256').update(str).digest('hex').toLowerCase();
}

/* ── Panggil iPaymu API ── */
async function ipaymuPost(endpoint, body) {
  const ts  = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  const sig = ipaymuSign(body);
  const res = await fetch(`${IPAYMU_URL}${endpoint}`, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      'va':           IPAYMU_VA,
      'signature':    sig,
      'timestamp':    ts,
    },
    body:    JSON.stringify(body),
    timeout: 15000,
  });
  return res.json();
}

/* ── Kirim pesan Telegram ── */
async function sendTg(chatId, text) {
  if (!BOT_TOKEN || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: String(chatId), text, parse_mode: 'Markdown' }),
      timeout: 8000,
    });
  } catch (e) { console.error('[TG]', e.message); }
}

/* ── Map metode bayar ke format iPaymu ── */
function mapMethod(m) {
  const t = (m || '').toLowerCase();
  if (['bca','bni','bri','mandiri','cimb','bsi','permata'].includes(t)) return 'va';
  if (t === 'cc' || t === 'credit_card') return 'cc';
  return 'qris'; // default: QRIS (gopay, ovo, dana, shopeepay, semua bisa scan)
}

/* ═══════════════════════════════════════════════════════════════
   AUTO-ACTIVATE — LANGSUNG aktifkan plan, tanpa perlu admin
   Dipanggil segera setelah iPaymu konfirmasi pembayaran berhasil
   ═══════════════════════════════════════════════════════════════ */
async function autoActivate(client, order) {
  /* Idempoten — jangan aktifkan dua kali */
  if (order.status === 'approved') {
    console.log(`[autoActivate] Order ${order.order_id} sudah approved, skip.`);
    return;
  }

  const days    = parseInt(order.duration) || 30;
  const expires = new Date(Date.now() + days * 86400000).toISOString();
  const coins   = COINS_BONUS[order.plan] || 300;
  const xp      = XP_BONUS[order.plan]    || 200;

  /* 1 ─ Update order → approved */
  await client.from('orders').update({
    status:       'approved',
    activated_at: new Date().toISOString(),
    expires_at:   expires,
    notified:     true,
    updated_at:   new Date().toISOString(),
  }).eq('order_id', order.order_id);

  /* 2 ─ Update profil user */
  let prof = null;
  if (order.user_id) {
    const { data } = await client
      .from('profiles').select('*').eq('id', order.user_id).single();
    prof = data;
    if (prof) {
      await client.from('profiles').update({
        plan:         order.plan,
        plan_expires: expires,
        coins:        (prof.coins || 0) + coins,
        xp:           (prof.xp    || 0) + xp,
        updated_at:   new Date().toISOString(),
      }).eq('id', order.user_id);
    }
  }

  /* 3 ─ Notifikasi in-app */
  if (order.user_id) {
    await client.from('notifications').insert({
      user_id: order.user_id,
      type:    'success',
      title:   '🎉 Pembayaran Berhasil — Paket Langsung Aktif!',
      message: `${order.plan === 'vip' ? '💎 VIP' : '⭐ Premium'} ${days} hari aktif sekarang. Bonus +${coins} koin & +${xp} XP!`,
      icon:    order.plan === 'vip' ? '💎' : '⭐',
    }).catch(() => {});

    await client.from('activity_log').insert({
      user_id:     order.user_id,
      type:        'payment',
      description: `Upgrade ke ${order.plan.toUpperCase()} ${days} hari`,
      icon:        order.plan === 'vip' ? '💎' : '⭐',
      xp_earned:   xp,
    }).catch(() => {});
  }

  /* 4 ─ Notifikasi Telegram ke USER — langsung, seketika */
  const tgId = order.telegram_id || prof?.telegram_id;
  const expStr = new Date(expires).toLocaleDateString('id-ID', {
    day: 'numeric', month: 'long', year: 'numeric',
  });
  if (tgId) {
    await sendTg(tgId,
`✅ *Pembayaran Berhasil!*
_Paket kamu langsung aktif otomatis_ 🚀

👤 Halo, *${order.customer_name}*!

📦 Paket: *${order.plan.toUpperCase()} ${days} Hari*
💵 Total Bayar: *Rp ${(order.price || 0).toLocaleString('id')}*
🪙 Bonus Koin: *+${coins} koin* (langsung masuk)
⭐ Bonus XP: *+${xp} XP* (langsung masuk)
🗓 Aktif Hingga: *${expStr}*
🔑 ID Order: \`${order.order_id}\`
─────────────────────────
${order.plan === 'vip'
  ? '💎 Akses ke *semua 10 model AI* sudah aktif!\nTermasuk Llama 405B, Qwen 72B, Gemma 27B.'
  : '⭐ Akses ke *model Premium* sudah aktif!\nLlama 70B, Mixtral 8x7B, DeepSeek R1.'}

👉 [Buka Dashboard](${WEB_URL}/dashboard)
👉 [Langsung Chat AI](${WEB_URL}/chat)`
    );
  }

  /* 5 ─ Info ke admin (hanya notifikasi, tidak perlu approval) */
  if (ADMIN_TG) {
    await sendTg(ADMIN_TG,
`💰 *[AUTO] Pembayaran Masuk & Langsung Aktif*

📋 \`${order.order_id}\`
👤 ${order.customer_name} | TG: ${tgId || '—'}
📦 ${order.plan.toUpperCase()} ${days} Hari
💵 Rp ${(order.price || 0).toLocaleString('id')} via ${order.payment_method || '—'}
${order.coupon ? `🏷 Kupon: ${order.coupon} (-Rp ${(order.discount||0).toLocaleString('id')})` : ''}
✅ *SUDAH OTOMATIS AKTIF — tidak perlu aksi apapun*`
    );
  }

  console.log(`[autoActivate] ✅ ${order.order_id} → ${order.plan} ${days}hr aktif hingga ${expires}`);
}

/* ═══════════════════════════════════════════════════════════════
   MAIN HANDLER
   ═══════════════════════════════════════════════════════════════ */
module.exports = async (req, res) => {
  cors(res, req);
  if (req.method === 'OPTIONS') return res.status(200).end();

  let client;
  try { client = sb(); }
  catch (e) { return res.status(500).json({ error: e.message }); }

  const action = req.query.action || '';

  /* ──────────────────────────────────────
     POST /api/payment  → Buat Order Baru
     ────────────────────────────────────── */
  if (req.method === 'POST' && !action) {
    const {
      plan, duration, name, email,
      telegram_id, payment_method, coupon, note,
    } = req.body || {};

    /* Validasi input */
    if (!plan || !['premium','vip'].includes(plan))
      return res.status(400).json({ error: 'Pilih paket: premium atau vip' });
    if (!duration || ![30,90].includes(parseInt(duration)))
      return res.status(400).json({ error: 'Pilih durasi: 30 atau 90 hari' });
    if (!name?.trim())
      return res.status(400).json({ error: 'Nama wajib diisi' });
    if (!telegram_id?.trim())
      return res.status(400).json({ error: 'ID Telegram wajib diisi' });

    const dur  = parseInt(duration);
    const base = PRICES[plan]?.[dur];
    if (!base) return res.status(400).json({ error: 'Harga tidak ditemukan' });

    /* Kupon */
    const couponUpper = (coupon || '').trim().toUpperCase();
    const discPct  = COUPONS[couponUpper] || 0;
    const discAmt  = Math.round(base * discPct);
    const total    = Math.max(0, base - discAmt);

    /* Order ID */
    const orderId = `KZ-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2,5).toUpperCase()}`;

    /* User dari token (opsional) */
    const authUser = await verifyToken(client, req.headers.authorization).catch(() => null);

    /* Simpan ke DB */
    const { data: order, error: orderErr } = await client.from('orders').insert({
      order_id:       orderId,
      user_id:        authUser?.id || null,
      telegram_id:    telegram_id.trim(),
      customer_name:  name.trim(),
      email:          (email || '').trim() || 'user@kizai.id',
      plan,
      duration:       dur,
      price:          total,
      payment_method: payment_method || 'qris',
      coupon:         discAmt > 0 ? couponUpper : null,
      discount:       discAmt,
      note:           (note || '').slice(0, 200),
      status:         'pending',
    }).select().single();

    if (orderErr)
      return res.status(500).json({ error: 'Gagal membuat order: ' + orderErr.message });

    /* ── Total = 0 (kupon 100%) → langsung aktif ── */
    if (total === 0) {
      await autoActivate(client, order);
      return res.json({
        order_id:    orderId,
        status:      'approved',
        redirect_url:`${WEB_URL}/checkout?status=success&order=${orderId}`,
        message:     'Selamat! Paket kamu langsung aktif gratis!',
      });
    }

    /* ── iPaymu belum dikonfigurasi ── */
    if (!IPAYMU_VA || !IPAYMU_KEY) {
      console.warn('[iPaymu] Belum dikonfigurasi — gunakan flow manual.');
      if (ADMIN_TG) {
        await sendTg(ADMIN_TG,
`🆕 *Order Baru (iPaymu belum aktif)*\n\`${orderId}\`\n${plan.toUpperCase()} ${dur}hr\nRp ${total.toLocaleString('id')}\n${name} | ${telegram_id}`
        );
      }
      return res.json({
        order_id: orderId,
        status:   'pending',
        message:  `Order dibuat. Hubungi admin untuk aktivasi. ID: ${orderId}`,
      });
    }

    /* ── Buat link pembayaran iPaymu ── */
    try {
      const ipBody = {
        product:      [`KizAi ${plan.toUpperCase()} ${dur} Hari`],
        qty:          [1],
        price:        [total],
        amount:       total,
        returnUrl:    `${WEB_URL}/checkout?status=success&order=${orderId}`,
        cancelUrl:    `${WEB_URL}/checkout?status=cancel&order=${orderId}`,
        notifyUrl:    `${WEB_URL}/api/payment?action=callback`,
        referenceId:  orderId,
        buyerName:    name.trim(),
        buyerEmail:   (email || '').trim() || 'user@kizai.id',
        buyerPhone:   telegram_id.trim(),
        paymentMethod:mapMethod(payment_method),
        comments:     `KizAi ${plan.toUpperCase()} ${dur}hr`,
      };

      const ipRes = await ipaymuPost('/payment', ipBody);
      console.log('[iPaymu] response:', JSON.stringify(ipRes));

      if (ipRes.Status === 200 && ipRes.Data?.Url) {
        /* Simpan data iPaymu ke order */
        await client.from('orders').update({
          payment_data: {
            ipaymu_session_id:  ipRes.Data.SessionId || '',
            ipaymu_payment_url: ipRes.Data.Url,
            ipaymu_created_at:  new Date().toISOString(),
          },
        }).eq('order_id', orderId);

        return res.json({
          order_id:     orderId,
          payment_url:  ipRes.Data.Url,
          session_id:   ipRes.Data.SessionId || '',
          status:       'pending',
          is_production:IPAYMU_PROD,
        });
      }

      /* Error dari iPaymu */
      console.error('[iPaymu] Error response:', ipRes);
      return res.status(502).json({
        error:  ipRes.Message || 'Gagal membuat link pembayaran, coba lagi.',
        detail: ipRes,
      });

    } catch (e) {
      console.error('[iPaymu] Exception:', e.message);
      return res.status(500).json({ error: 'Gagal menghubungi iPaymu: ' + e.message });
    }
  }

  /* ──────────────────────────────────────
     POST ?action=callback
     iPaymu kirim notifikasi ke sini
     saat pembayaran BERHASIL / GAGAL
     ────────────────────────────────────── */
  if (req.method === 'POST' && action === 'callback') {
    const body = req.body || {};
    console.log('[iPaymu Callback]', JSON.stringify(body));

    /*
      iPaymu mengirimkan:
      reference_id  → order_id kita
      status        → "berhasil" | "pending" | "gagal" | "expired"
      trx_id        → ID transaksi iPaymu
      amount        → nominal yang dibayar
    */
    const refId  = body.reference_id || body.referenceId || '';
    const status = (body.status || body.Status || '').toLowerCase().trim();
    const trxId  = body.trx_id || body.trxId || body.TransactionId || '';

    if (!refId) {
      console.error('[Callback] reference_id kosong');
      return res.status(400).json({ error: 'reference_id wajib' });
    }

    const { data: order } = await client
      .from('orders').select('*').eq('order_id', refId).single();

    if (!order) {
      console.error('[Callback] Order tidak ditemukan:', refId);
      return res.status(200).json({ status: 'ok', note: 'order not found, ignored' });
    }

    /* Simpan trx_id */
    if (trxId) {
      await client.from('orders').update({
        payment_data: {
          ...(order.payment_data || {}),
          ipaymu_trx_id: trxId,
          ipaymu_status: status,
          ipaymu_callback_at: new Date().toISOString(),
        },
      }).eq('order_id', refId);
    }

    const isSuccess = ['berhasil','success','settlement','capture','paid'].includes(status);
    const isFailed  = ['gagal','failed','cancel','cancelled','expire','expired','deny','denied'].includes(status);

    /* ── BERHASIL → AUTO-AKTIF SEKETIKA ── */
    if (isSuccess) {
      await autoActivate(client, order);
      return res.status(200).json({ status: 'ok', message: 'activated' });
    }

    /* ── GAGAL / EXPIRED ── */
    if (isFailed) {
      const newStatus = ['expire','expired'].includes(status) ? 'expired' : 'rejected';
      await client.from('orders').update({ status: newStatus, updated_at: new Date().toISOString() })
        .eq('order_id', refId);

      const tgId = order.telegram_id;
      if (tgId) {
        await sendTg(tgId,
`❌ *Pembayaran ${status === 'expired' ? 'Kedaluwarsa' : 'Gagal/Dibatalkan'}*

ID Order: \`${refId}\`
Paket: ${order.plan?.toUpperCase()} ${order.duration} Hari

Jika sudah membayar tapi status ini muncul, hubungi support kami.
👉 [Order Ulang](${WEB_URL}/checkout)
👉 [Support](https://t.me/kizai_support)`
        );
      }
    }

    /* iPaymu butuh respons 200 agar tidak retry */
    return res.status(200).json({ status: 'ok' });
  }

  /* ──────────────────────────────────────
     GET ?action=check&order_id=...
     Cek status order (dipanggil dari frontend
     setelah user kembali dari halaman bayar)
     ────────────────────────────────────── */
  if (req.method === 'GET' && action === 'check') {
    const orderId = req.query.order_id;
    if (!orderId) return res.status(400).json({ error: 'order_id wajib' });

    const { data: order } = await client.from('orders')
      .select('status,plan,duration,price,expires_at,payment_data')
      .eq('order_id', orderId).single();

    if (!order) return res.status(404).json({ error: 'Order tidak ditemukan' });

    /* Jika masih pending, coba cek langsung ke iPaymu */
    if (order.status === 'pending' && IPAYMU_VA && IPAYMU_KEY) {
      try {
        const checkBody = { referenceId: orderId };
        const checkRes  = await ipaymuPost('/transaction', checkBody);
        if (checkRes.Status === 200 && checkRes.Data) {
          const s = (checkRes.Data.Status || '').toLowerCase();
          if (['berhasil','success','settlement','paid'].includes(s)) {
            const { data: freshOrder } = await client.from('orders').select('*').eq('order_id', orderId).single();
            if (freshOrder && freshOrder.status !== 'approved') {
              await autoActivate(client, freshOrder);
              return res.json({ order_id: orderId, status: 'approved' });
            }
          }
        }
      } catch (e) { console.error('[check iPaymu]', e.message); }
    }

    return res.json({
      order_id:   orderId,
      status:     order.status,
      plan:       order.plan,
      duration:   order.duration,
      expires_at: order.expires_at,
    });
  }

  /* ──────────────────────────────────────
     GET ?action=my_orders — Riwayat Order
     ────────────────────────────────────── */
  if (req.method === 'GET' && action === 'my_orders') {
    const user = await verifyToken(client, req.headers.authorization);
    if (!user) return res.status(401).json({ error: 'Login dulu' });
    const { data } = await client.from('orders')
      .select('order_id,plan,duration,price,status,created_at,activated_at,expires_at,payment_method,coupon,discount')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(20);
    return res.json({ orders: data || [] });
  }

  return res.status(404).json({ error: `Action tidak ditemukan: ${action}` });
};
