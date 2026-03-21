'use strict';
const { sb, verifyToken, MODEL_ACCESS, ok, err, preflight, parseEvent, rateLimit } = require('./utils/supabase');

const CF_ACCOUNT = process.env.CF_ACCOUNT_ID || '';
const CF_TOKEN   = process.env.CF_API_TOKEN   || '';
const CF_BASE    = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/ai/run`;

const CF_MODELS = {
  'llama-8b':    '@cf/meta/llama-3.1-8b-instruct',
  'deepseek-7b': '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',
  'phi3-mini':   '@cf/microsoft/phi-2',
  'mistral-7b':  '@cf/mistral/mistral-7b-instruct-v0.2',
  'llama-70b':   '@cf/meta/llama-3.1-70b-instruct',
  'mixtral-8x7b':'@hf/mistralai/mixtral-8x7b-instruct-v0.1',
  'deepseek-r1': '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',
  'qwen-72b':    '@cf/qwen/qwen1.5-72b-chat',
  'gemma-27b':   '@cf/google/gemma-7b-it',
  'llama-405b':  '@cf/meta/llama-3.1-70b-instruct',
};

const RATE = { free: 10, premium: 30, vip: 100 };

async function callCF(modelId, messages) {
  const res = await fetch(`${CF_BASE}/${modelId}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${CF_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, max_tokens: 2048 }),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e?.errors?.[0]?.message || `CF error ${res.status}`);
  }
  return res;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();

  let client;
  try { client = sb(); } catch (e) { return err(e.message, 500); }

  const { method, query, body, headers } = parseEvent(event);
  const action = query.action || '';

  /* ── TOOLS AI (no auth needed) ── */
  if (method === 'POST' && action === 'tools_ai') {
    const { message, model_id = 'llama-8b' } = body;
    if (!message?.trim()) return err('message wajib diisi');
    if (!CF_ACCOUNT || !CF_TOKEN) {
      return ok({ response: `[Demo] Pertanyaanmu: "${message.slice(0,80)}..." — Aktifkan dengan CF_ACCOUNT_ID + CF_API_TOKEN di Netlify.` });
    }
    try {
      const cfRes = await callCF(CF_MODELS[model_id] || CF_MODELS['llama-8b'], [
        { role: 'system', content: 'Kamu adalah KizAi, asisten AI Indonesia. Jawab dalam Bahasa Indonesia, singkat dan tepat.' },
        { role: 'user', content: message.trim().slice(0, 3000) }
      ]);
      const d = await cfRes.json();
      const text = d?.result?.response || d?.result?.choices?.[0]?.message?.content || 'Tidak ada respons.';
      return ok({ response: text });
    } catch (e) { return err('AI error: ' + e.message, 500); }
  }

  const user = await verifyToken(client, headers.authorization);
  if (!user) return err('Silakan login terlebih dahulu', 401);

  /* ── GET SESSIONS ── */
  if (method === 'GET' && action === 'sessions') {
    const { data } = await client.from('chat_sessions').select('*').eq('user_id', user.id).order('updated_at', { ascending: false }).limit(50);
    return ok({ sessions: data || [] });
  }

  /* ── NEW SESSION ── */
  if (method === 'POST' && action === 'new_session') {
    const { data, error } = await client.from('chat_sessions').insert({ user_id: user.id, title: 'Chat Baru', model_id: body.model_id || 'llama-8b', message_count: 0 }).select().single();
    if (error) return err(error.message);
    return ok({ session: data });
  }

  /* ── GET MESSAGES ── */
  if (method === 'GET' && action === 'messages') {
    const { data: sess } = await client.from('chat_sessions').select('user_id').eq('id', query.session_id).single();
    if (!sess || sess.user_id !== user.id) return err('Akses ditolak', 403);
    const { data } = await client.from('chat_messages').select('*').eq('session_id', query.session_id).order('created_at', { ascending: true }).limit(200);
    return ok({ messages: data || [] });
  }

  /* ── RENAME SESSION ── */
  if (method === 'PUT' && action === 'rename_session') {
    if (!body.title?.trim()) return err('Judul wajib diisi');
    await client.from('chat_sessions').update({ title: body.title.slice(0, 60), updated_at: new Date().toISOString() }).eq('id', query.id).eq('user_id', user.id);
    return ok({ ok: true });
  }

  /* ── PIN SESSION ── */
  if (method === 'PUT' && action === 'pin_session') {
    await client.from('chat_sessions').update({ is_pinned: !!body.is_pinned }).eq('id', query.id).eq('user_id', user.id);
    return ok({ ok: true });
  }

  /* ── DELETE SESSION ── */
  if (method === 'DELETE' && action === 'delete_session') {
    await client.from('chat_messages').delete().eq('session_id', query.id);
    await client.from('chat_sessions').delete().eq('id', query.id).eq('user_id', user.id);
    return ok({ ok: true });
  }

  /* ── DELETE ALL ── */
  if (method === 'DELETE' && action === 'delete_all') {
    const { data: sessions } = await client.from('chat_sessions').select('id').eq('user_id', user.id);
    for (const s of sessions || []) await client.from('chat_messages').delete().eq('session_id', s.id);
    await client.from('chat_sessions').delete().eq('user_id', user.id);
    return ok({ ok: true });
  }

  /* ── SEND MESSAGE ── */
  if (method === 'POST' && (!action || action === 'send')) {
    const { session_id, message, model_id = 'llama-8b', history = [] } = body;
    if (!session_id || !message?.trim()) return err('session_id dan message wajib diisi');

    const plan = user.effective_plan || 'free';
    if (!rateLimit(user.id + ':chat', RATE[plan] || 10, 60000)) return err(`Rate limit: ${RATE[plan]} pesan/menit untuk plan ${plan}`, 429);

    const accessible = MODEL_ACCESS[plan] || MODEL_ACCESS.free;
    if (!accessible.includes(model_id)) return err(`Model ${model_id} memerlukan upgrade plan`, 403);

    const { data: sess } = await client.from('chat_sessions').select('*').eq('id', session_id).eq('user_id', user.id).single();
    if (!sess) return err('Sesi tidak ditemukan', 404);

    const userContent = message.trim().slice(0, 4000);
    const { data: userMsg } = await client.from('chat_messages').insert({ session_id, user_id: user.id, role: 'user', content: userContent, model_id }).select().single();

    const aiMessages = [
      { role: 'system', content: `Kamu adalah KizAi, asisten AI Indonesia. Jawab dalam Bahasa Indonesia. User: ${user.username} | Plan: ${plan}` },
      ...history.slice(-8).map(m => ({ role: m.role, content: m.content.slice(0, 2000) })),
      { role: 'user', content: userContent }
    ];

    let aiContent = `Halo **${user.username}**! Aktifkan Cloudflare AI dengan CF_ACCOUNT_ID dan CF_API_TOKEN di Netlify untuk fitur chat.`;

    if (CF_ACCOUNT && CF_TOKEN) {
      try {
        const cfRes = await callCF(CF_MODELS[model_id] || CF_MODELS['llama-8b'], aiMessages);
        const cfData = await cfRes.json();
        aiContent = cfData?.result?.response || cfData?.result?.choices?.[0]?.message?.content || 'Maaf, tidak ada respons.';
      } catch (e) { aiContent = `Error AI: ${e.message}`; }
    }

    const tokens = Math.ceil((userContent.length + aiContent.length) / 4);
    const { data: aiMsg } = await client.from('chat_messages').insert({ session_id, user_id: user.id, role: 'assistant', content: aiContent, model_id, tokens_used: tokens }).select().single();

    await client.from('chat_sessions').update({ message_count: (sess.message_count || 0) + 2, last_message: userContent.slice(0, 80), updated_at: new Date().toISOString() }).eq('id', session_id).catch(() => {});
    await client.from('profiles').update({ xp: (user.xp || 0) + 2, chat_messages: (user.chat_messages || 0) + 1 }).eq('id', user.id).catch(() => {});

    return ok({ user_message: userMsg, ai_message: aiMsg });
  }

  return err(`Action tidak dikenal: "${action}"`, 404);
};
