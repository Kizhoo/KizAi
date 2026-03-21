'use strict';
const { sb, verifyToken, cors, rateLimit, MODEL_ACCESS } = require('../lib/supabase');

/* ═══════════════════════════════════════════════════════════════
   Cloudflare AI Workers
   https://developers.cloudflare.com/workers-ai/

   Env vars:
   CF_ACCOUNT_ID  → Cloudflare Account ID (dashboard.cloudflare.com → kanan bawah)
   CF_API_TOKEN   → API Token dengan permission "Workers AI:Read"
                    (cloudflare.com → My Profile → API Tokens → Create Token)
   ═══════════════════════════════════════════════════════════════ */
const CF_ACCOUNT = process.env.CF_ACCOUNT_ID || '';
const CF_TOKEN   = process.env.CF_API_TOKEN  || '';
const CF_BASE    = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/ai/run`;

/* ── Model KizAi → Cloudflare AI model ID ── */
const CF_MODELS = {
  'llama-8b':     '@cf/meta/llama-3.1-8b-instruct',
  'deepseek-7b':  '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',
  'phi3-mini':    '@cf/microsoft/phi-2',
  'mistral-7b':   '@cf/mistral/mistral-7b-instruct-v0.2',
  'llama-70b':    '@cf/meta/llama-3.1-70b-instruct',
  'mixtral-8x7b': '@hf/mistralai/mixtral-8x7b-instruct-v0.1',
  'deepseek-r1':  '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',
  'qwen-72b':     '@cf/qwen/qwen1.5-72b-chat',
  'gemma-27b':    '@cf/google/gemma-7b-it',
  'llama-405b':   '@cf/meta/llama-3.1-70b-instruct',  // CF belum ada 405B, pakai 70B
};

const rateLimits = new Map();
const PLAN_LIMITS = { free: 10, premium: 30, vip: 100 }; // request/menit

/* ═══════════════════════════════════════════════════════════════
   Panggil Cloudflare AI
   ═══════════════════════════════════════════════════════════════ */
async function callCF(modelId, messages, stream = false) {
  if (!CF_ACCOUNT || !CF_TOKEN)
    throw new Error('CF_ACCOUNT_ID / CF_API_TOKEN belum diset di environment variables');

  const url = `${CF_BASE}/${modelId}`;
  const res = await fetch(url, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${CF_TOKEN}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({ messages, stream, max_tokens: 4096 }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.errors?.[0]?.message || `Cloudflare AI error ${res.status}`);
  }

  return res; // kembalikan response mentah agar bisa stream
}

/* ═══════════════════════════════════════════════════════════════
   MAIN HANDLER
   ═══════════════════════════════════════════════════════════════ */

/* ── Body parser ─────────────────────────────────────────────────────
   @vercel/node (builds format) sudah auto-parse JSON body.
   Handle edge case kalau body sudah object atau masih string/stream.
   ─────────────────────────────────────────────────────────────────── */
async function parseBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'object') return req.body;
    if (typeof req.body === 'string') {
      try { return JSON.parse(req.body); } catch { return {}; }
    }
    return {};
  }
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk.toString(); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
    setTimeout(() => resolve({}), 5000);
  });
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  req.body = await parseBody(req);

  let client;
  try { client = sb(); }
  catch (e) { return res.status(500).json({ error: e.message }); }

  const action = req.query.action || '';
  /* ── TOOLS AI — simple AI call without session (for tools page) ── */
  if (req.method === 'POST' && action === 'tools_ai') {
    const { message, model_id = 'llama-8b' } = req.body || {};
    if (!message?.trim()) return res.status(400).json({ error: 'message wajib diisi' });

    const cfModel = CF_MODELS[model_id] || CF_MODELS['llama-8b'];

    if (!CF_ACCOUNT || !CF_TOKEN) {
      return res.json({
        response: `[Demo Mode] AI akan menjawab: "${message.slice(0,50)}..." — Set CF_ACCOUNT_ID dan CF_API_TOKEN untuk mengaktifkan AI sungguhan.`
      });
    }

    try {
      const cfRes = await callCF(cfModel, [
        { role: 'system', content: 'Kamu adalah KizAi, asisten AI Indonesia yang helpful. Jawab singkat dan tepat sasaran dalam Bahasa Indonesia.' },
        { role: 'user', content: message.trim().slice(0, 3000) }
      ], false);
      const cfData = await cfRes.json();
      const text = cfData?.result?.response || cfData?.result?.choices?.[0]?.message?.content || 'Maaf, tidak ada respons.';
      return res.json({ response: text });
    } catch (e) {
      return res.status(500).json({ error: 'AI error: ' + e.message });
    }
  }

  const user   = await verifyToken(client, req.headers.authorization);
  if (!user) return res.status(401).json({ error: 'Silakan login terlebih dahulu' });

  /* ── GET SESSIONS ── */
  if (req.method === 'GET' && action === 'sessions') {
    const { data } = await client.from('chat_sessions').select('*')
      .eq('user_id', user.id).order('updated_at', { ascending: false }).limit(50);
    return res.json({ sessions: data || [] });
  }

  /* ── NEW SESSION ── */
  if (req.method === 'POST' && action === 'new_session') {
    const { model_id } = req.body || {};
    const { data, error } = await client.from('chat_sessions').insert({
      user_id: user.id, title: 'Chat Baru',
      model_id: model_id || 'llama-8b', message_count: 0,
    }).select().single();
    if (error) return res.status(400).json({ error: error.message });
    return res.json({ session: data });
  }

  /* ── GET MESSAGES ── */
  if (req.method === 'GET' && action === 'messages') {
    const sid = req.query.session_id;
    if (!sid) return res.status(400).json({ error: 'session_id wajib' });
    const { data: sess } = await client.from('chat_sessions').select('user_id').eq('id', sid).single();
    if (!sess || sess.user_id !== user.id) return res.status(403).json({ error: 'Akses ditolak' });
    const { data } = await client.from('chat_messages').select('*')
      .eq('session_id', sid).order('created_at', { ascending: true }).limit(200);
    return res.json({ messages: data || [] });
  }

  /* ── RENAME SESSION ── */
  if (req.method === 'PUT' && action === 'rename_session') {
    const { title } = req.body || {};
    if (!title?.trim()) return res.status(400).json({ error: 'Judul wajib diisi' });
    await client.from('chat_sessions')
      .update({ title: title.slice(0, 60), updated_at: new Date().toISOString() })
      .eq('id', req.query.id).eq('user_id', user.id);
    return res.json({ ok: true });
  }

  /* ── PIN SESSION ── */
  if (req.method === 'PUT' && action === 'pin_session') {
    const { is_pinned } = req.body || {};
    await client.from('chat_sessions')
      .update({ is_pinned: !!is_pinned })
      .eq('id', req.query.id).eq('user_id', user.id);
    return res.json({ ok: true });
  }

  /* ── UPDATE SESSION ── */
  if (req.method === 'PUT' && action === 'update_session') {
    const upd = {};
    if (req.body?.model_id) upd.model_id = req.body.model_id;
    if (req.body?.title)    upd.title    = req.body.title.slice(0, 60);
    upd.updated_at = new Date().toISOString();
    await client.from('chat_sessions').update(upd).eq('id', req.query.id).eq('user_id', user.id);
    return res.json({ ok: true });
  }

  /* ── DELETE SESSION ── */
  if (req.method === 'DELETE' && action === 'delete_session') {
    await client.from('chat_messages').delete().eq('session_id', req.query.id);
    await client.from('chat_sessions').delete().eq('id', req.query.id).eq('user_id', user.id);
    return res.json({ ok: true });
  }

  /* ── DELETE ALL ── */
  if (req.method === 'DELETE' && action === 'delete_all') {
    const { data: sessions } = await client.from('chat_sessions').select('id').eq('user_id', user.id);
    for (const s of sessions || [])
      await client.from('chat_messages').delete().eq('session_id', s.id);
    await client.from('chat_sessions').delete().eq('user_id', user.id);
    return res.json({ ok: true });
  }

  /* ── DELETE MESSAGE ── */
  if (req.method === 'DELETE' && action === 'delete_message') {
    await client.from('chat_messages').delete().eq('id', req.query.id).eq('user_id', user.id);
    return res.json({ ok: true });
  }

  /* ══════════════════════════════════════════════════════════════
     SEND MESSAGE — inti fitur Chat AI via Cloudflare Workers AI
     ══════════════════════════════════════════════════════════════ */
  if (req.method === 'POST' && (!action || action === 'send')) {
    const { session_id, message, model_id, history = [] } = req.body || {};

    if (!session_id || !message?.trim())
      return res.status(400).json({ error: 'session_id dan message wajib diisi' });

    /* Cek rate limit per plan */
    const plan  = user.effective_plan || 'free';
    const limit = PLAN_LIMITS[plan] || 10;
    if (!rateLimit(rateLimits, user.id, limit, 60000))
      return res.status(429).json({
        error: `Rate limit: ${limit} pesan/menit untuk plan ${plan}. Upgrade untuk batas lebih tinggi!`,
      });

    /* Cek akses model */
    const reqModel   = model_id || 'llama-8b';
    const accessible = MODEL_ACCESS[plan] || MODEL_ACCESS.free;
    if (!accessible.includes(reqModel))
      return res.status(403).json({
        error: `Model ${reqModel} memerlukan plan lebih tinggi. Upgrade sekarang!`,
      });

    /* Verifikasi kepemilikan sesi */
    const { data: sess } = await client.from('chat_sessions')
      .select('*').eq('id', session_id).eq('user_id', user.id).single();
    if (!sess) return res.status(404).json({ error: 'Sesi tidak ditemukan' });

    const cfModel     = CF_MODELS[reqModel] || CF_MODELS['llama-8b'];
    const userContent = message.trim().slice(0, 4000);

    /* Simpan pesan user ke DB */
    const { data: userMsg } = await client.from('chat_messages').insert({
      session_id, user_id: user.id,
      role: 'user', content: userContent, model_id: reqModel,
    }).select().single();

    /* Bangun konteks pesan untuk AI (system + history + user) */
    const aiMessages = [
      {
        role:    'system',
        content: `Kamu adalah KizAi, asisten AI cerdas dan ramah dari Indonesia. ` +
                 `Jawab dalam Bahasa Indonesia kecuali diminta bahasa lain. ` +
                 `Berikan jawaban yang helpful, akurat, dan natural. ` +
                 `User: ${user.username} | Plan: ${plan} | Model: ${reqModel}`,
      },
      /* Ambil max 10 pesan terakhir sebagai konteks */
      ...history.slice(-10).map(m => ({ role: m.role, content: m.content.slice(0, 2000) })),
      { role: 'user', content: userContent },
    ];

    /* ── Mode demo jika CF belum dikonfigurasi ── */
    if (!CF_ACCOUNT || !CF_TOKEN) {
      const demo = `Halo **${user.username}**! 👋\n\n` +
        `Ini respons demo — Cloudflare AI belum dikonfigurasi.\n\n` +
        `Tambahkan **CF_ACCOUNT_ID** dan **CF_API_TOKEN** ke environment variables untuk mengaktifkan AI.\n\n` +
        `Model yang kamu pilih: \`${reqModel}\` (Cloudflare: \`${cfModel}\`)\n` +
        `Plan: **${plan}**`;
      const { data: aiMsg } = await client.from('chat_messages').insert({
        session_id, user_id: user.id,
        role: 'assistant', content: demo,
        model_id: reqModel, tokens_used: 50,
      }).select().single();
      await updateSession(client, session_id, sess.message_count, userContent);
      await updateUserStats(client, user.id);
      return res.json({ user_message: userMsg, ai_message: aiMsg });
    }

    /* ── Deteksi apakah client minta streaming ── */
    const wantsStream = req.headers.accept?.includes('text/event-stream') ||
                        req.headers['x-stream'] === '1';

  

  /* ══════════ STREAMING ══════════ */
    if (wantsStream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no'); // penting untuk Vercel/nginx

      try {
        const cfRes = await callCF(cfModel, aiMessages, true);
        const reader  = cfRes.body.getReader();
        const decoder = new TextDecoder();
        let fullText  = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          /*
            Cloudflare AI streaming format:
            data: {"response":"token"}
            data: {"response":"next token"}
            data: [DONE]
          */
          for (const line of chunk.split('\n')) {
            const l = line.trim();
            if (!l || l === 'data: [DONE]') continue;
            const raw = l.startsWith('data: ') ? l.slice(6) : l;
            try {
              const parsed = JSON.parse(raw);
              /* Cloudflare kirim: { response: "token" } */
              const token = parsed.response || parsed.token ||
                            parsed.choices?.[0]?.delta?.content || '';
              if (token) {
                fullText += token;
                /* Teruskan ke client dalam format SSE */
                res.write(`data: ${JSON.stringify({ token })}\n\n`);
              }
            } catch {}
          }
        }

        res.write('data: [DONE]\n\n');
        res.end();

        /* Simpan respons AI ke DB setelah stream selesai */
        if (fullText) {
          const tokens = Math.ceil((userContent.length + fullText.length) / 4);
          await client.from('chat_messages').insert({
            session_id, user_id: user.id,
            role: 'assistant', content: fullText,
            model_id: reqModel, tokens_used: tokens,
          });
          await updateSession(client, session_id, sess.message_count, userContent);
          await updateUserStats(client, user.id);
        }

      } catch (e) {
        console.error('[CF Stream]', e.message);
        res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
        res.end();
      }
      return;
    }

    /* ══════════ NON-STREAMING (fallback) ══════════ */
    try {
      const cfRes  = await callCF(cfModel, aiMessages, false);
      const cfData = await cfRes.json();

      /*
        Cloudflare AI non-streaming response:
        { success: true, result: { response: "..." } }
      */
      const aiContent = cfData?.result?.response ||
                        cfData?.result?.choices?.[0]?.message?.content ||
                        'Maaf, tidak ada respons dari AI.';

      const tokens = Math.ceil((userContent.length + aiContent.length) / 4);
      const { data: aiMsg } = await client.from('chat_messages').insert({
        session_id, user_id: user.id,
        role: 'assistant', content: aiContent,
        model_id: reqModel, tokens_used: tokens,
      }).select().single();

      await updateSession(client, session_id, sess.message_count, userContent);
      await updateUserStats(client, user.id);

      return res.json({
        user_message: userMsg,
        ai_message:   aiMsg,
        session: { ...sess, message_count: sess.message_count + 2 },
      });

    } catch (e) {
      console.error('[CF Non-Stream]', e.message);
      return res.status(500).json({ error: 'Gagal menghubungi Cloudflare AI: ' + e.message });
    }
  }

  return res.status(404).json({ error: 'Action tidak ditemukan: ' + action });
};

/* ── Update sesi (jumlah pesan + last_message) ── */
async function updateSession(client, sessionId, prevCount, lastMsg) {
  await client.from('chat_sessions').update({
    message_count: (prevCount || 0) + 2,
    last_message:  lastMsg.slice(0, 80),
    updated_at:    new Date().toISOString(),
  }).eq('id', sessionId);
}

/* ── Update statistik user (XP, level, chat_messages) ── */
async function updateUserStats(client, userId) {
  try {
    const { data: p } = await client.from('profiles')
      .select('xp, level, chat_messages').eq('id', userId).single();
    if (!p) return;

    const newXp    = (p.xp || 0) + 2;
    const newLevel = Math.min(Math.floor(Math.pow(newXp / 100, 0.7)) + 1, 999);
    await client.from('profiles').update({
      xp:            newXp,
      level:         newLevel,
      chat_messages: (p.chat_messages || 0) + 1,
      updated_at:    new Date().toISOString(),
    }).eq('id', userId);

    await client.from('activity_log').insert({
      user_id:     userId,
      type:        'chat',
      description: 'Mengirim pesan AI',
      icon:        '💬',
      xp_earned:   2,
    }).catch(() => {});
  } catch (e) {
    console.error('[updateUserStats]', e.message);
  }
}
