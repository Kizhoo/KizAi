'use strict';
const { Router } = require('express');
const { sb, verifyToken, MODEL_ACCESS, rateLimit } = require('../lib/supabase');

const router  = Router();
const CF_ACCOUNT = process.env.CF_ACCOUNT_ID || '';
const CF_TOKEN   = process.env.CF_API_TOKEN   || '';
const CF_BASE    = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/ai/run`;

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
  'llama-405b':   '@cf/meta/llama-3.1-70b-instruct',
};

const RATE = { free: 10, premium: 30, vip: 100 };

async function callCF(modelId, messages) {
  const res = await fetch(`${CF_BASE}/${modelId}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${CF_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, max_tokens: 2048 }),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e?.errors?.[0]?.message || `CF error ${res.status}`);
  }
  return res;
}

router.all('*', async (req, res) => {
  let client;
  try { client = sb(); } catch (e) { return res.status(500).json({ error: e.message }); }

  const action = req.query.action || '';

  /* ── TOOLS AI — no auth required ── */
  if (req.method === 'POST' && action === 'tools_ai') {
    const { message, model_id = 'llama-8b' } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: 'message wajib diisi' });
    if (!CF_ACCOUNT || !CF_TOKEN)
      return res.json({ response: `[Demo] "${message.slice(0, 80)}..." — Set CF_ACCOUNT_ID + CF_API_TOKEN di Railway Variables.` });
    try {
      const cfRes = await callCF(CF_MODELS[model_id] || CF_MODELS['llama-8b'], [
        { role: 'system', content: 'Kamu adalah KizAi, asisten AI Indonesia. Jawab singkat dan tepat dalam Bahasa Indonesia.' },
        { role: 'user', content: message.trim().slice(0, 3000) },
      ]);
      const d = await cfRes.json();
      const text = d?.result?.response || d?.result?.choices?.[0]?.message?.content || 'Tidak ada respons.';
      return res.json({ response: text });
    } catch (e) { return res.status(500).json({ error: 'AI error: ' + e.message }); }
  }

  const user = await verifyToken(client, req.headers.authorization);
  if (!user) return res.status(401).json({ error: 'Silakan login terlebih dahulu' });

  /* ── GET SESSIONS ── */
  if (req.method === 'GET' && action === 'sessions') {
    const { data } = await client.from('chat_sessions').select('*')
      .eq('user_id', user.id).order('updated_at', { ascending: false }).limit(50);
    return res.json({ sessions: data || [] });
  }

  /* ── NEW SESSION ── */
  if (req.method === 'POST' && action === 'new_session') {
    const { data, error } = await client.from('chat_sessions')
      .insert({ user_id: user.id, title: 'Chat Baru', model_id: req.body.model_id || 'llama-8b', message_count: 0 })
      .select().single();
    if (error) return res.status(400).json({ error: error.message });
    return res.json({ session: data });
  }

  /* ── GET MESSAGES ── */
  if (req.method === 'GET' && action === 'messages') {
    const { data: sess } = await client.from('chat_sessions').select('user_id').eq('id', req.query.session_id).single();
    if (!sess || sess.user_id !== user.id) return res.status(403).json({ error: 'Akses ditolak' });
    const { data } = await client.from('chat_messages').select('*')
      .eq('session_id', req.query.session_id).order('created_at', { ascending: true }).limit(200);
    return res.json({ messages: data || [] });
  }

  /* ── RENAME SESSION ── */
  if (req.method === 'PUT' && action === 'rename_session') {
    if (!req.body.title?.trim()) return res.status(400).json({ error: 'Judul wajib diisi' });
    await client.from('chat_sessions').update({ title: req.body.title.slice(0, 60), updated_at: new Date().toISOString() }).eq('id', req.query.id).eq('user_id', user.id);
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
    for (const s of sessions || []) await client.from('chat_messages').delete().eq('session_id', s.id);
    await client.from('chat_sessions').delete().eq('user_id', user.id);
    return res.json({ ok: true });
  }

  /* ── PIN / UNPIN SESSION ── */
  if (req.method === 'PUT' && action === 'pin_session') {
    const { is_pinned } = req.body;
    await client.from('chat_sessions')
      .update({ is_pinned: !!is_pinned, updated_at: new Date().toISOString() })
      .eq('id', req.query.id).eq('user_id', user.id);
    return res.json({ ok: true });
  }

  /* ── UPDATE SESSION (model, title, etc) ── */
  if (req.method === 'PUT' && action === 'update_session') {
    const allowed = {};
    if (req.body.model_id) allowed.model_id = req.body.model_id;
    if (req.body.title)    allowed.title    = req.body.title.slice(0, 60);
    allowed.updated_at = new Date().toISOString();
    await client.from('chat_sessions').update(allowed).eq('id', req.query.id).eq('user_id', user.id);
    return res.json({ ok: true });
  }

  /* ── DELETE SINGLE MESSAGE ── */
  if (req.method === 'DELETE' && action === 'delete_message') {
    // Only allow deleting own messages
    await client.from('chat_messages')
      .delete()
      .eq('id', req.query.id)
      .eq('user_id', user.id);
    return res.json({ ok: true });
  }

  /* ── SEND MESSAGE ── */
  if (req.method === 'POST' && (!action || action === 'send')) {
    const { session_id, message, model_id = 'llama-8b', history = [] } = req.body;
    if (!session_id || !message?.trim())
      return res.status(400).json({ error: 'session_id dan message wajib diisi' });

    const plan = user.effective_plan || 'free';
    if (!rateLimit(user.id + ':chat', RATE[plan] || 10, 60000))
      return res.status(429).json({ error: `Rate limit: ${RATE[plan]} pesan/menit (plan ${plan})` });

    const accessible = MODEL_ACCESS[plan] || MODEL_ACCESS.free;
    if (!accessible.includes(model_id))
      return res.status(403).json({ error: `Model ${model_id} memerlukan upgrade plan` });

    const { data: sess } = await client.from('chat_sessions').select('*').eq('id', session_id).eq('user_id', user.id).single();
    if (!sess) return res.status(404).json({ error: 'Sesi tidak ditemukan' });

    const userContent = message.trim().slice(0, 4000);
    const { data: userMsg } = await client.from('chat_messages').insert({ session_id, user_id: user.id, role: 'user', content: userContent, model_id }).select().single();

    const aiMessages = [
      { role: 'system', content: `Kamu adalah KizAi, asisten AI Indonesia. Jawab dalam Bahasa Indonesia. User: ${user.username} | Plan: ${plan}` },
      ...history.slice(-8).map(m => ({ role: m.role, content: m.content.slice(0, 2000) })),
      { role: 'user', content: userContent },
    ];

    let aiContent = `Halo **${user.username}**! Aktifkan Cloudflare AI dengan CF_ACCOUNT_ID dan CF_API_TOKEN di Railway Variables untuk fitur chat.`;
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
    return res.json({ user_message: userMsg, ai_message: aiMsg });
  }

  return res.status(404).json({ error: `Action tidak dikenal: "${action}"` });
});

module.exports = router;
