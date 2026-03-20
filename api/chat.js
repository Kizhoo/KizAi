'use strict';
const { sb, verifyToken, effectivePlan, accessibleModels, cors } = require('../lib/supabase');

const CF_ACC = process.env.CF_ACCOUNT_ID || '';
const CF_KEY = process.env.CF_API_TOKEN   || '';

const MODEL_TIERS = {
  'llama-8b':       'free',
  'deepseek-coder': 'free',
  'phi-3-mini':     'free',
  'llama-70b':      'premium',
  'mixtral':        'premium',
  'mistral-7b':     'premium',
  'qwen-72b':       'vip',
  'deepseek-r1':    'vip',
  'gemma-27b':      'vip',
};
const CF_IDS = {
  'llama-8b':       '@cf/meta/llama-3.1-8b-instruct',
  'deepseek-coder': '@hf/thebloke/deepseek-coder-6.7b-instruct-awq',
  'phi-3-mini':     '@cf/microsoft/phi-2',
  'llama-70b':      '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  'mixtral':        '@cf/mistral/mistral-7b-instruct-v0.1',
  'mistral-7b':     '@cf/mistral/mistral-7b-instruct-v0.1',
  'qwen-72b':       '@cf/qwen/qwen2.5-72b-instruct',
  'deepseek-r1':    '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',
  'gemma-27b':      '@cf/google/gemma-7b-it',
};

function planAllows(plan, tier) {
  if (plan === 'premium') return true;
  if (plan === 'vip') return ['free','vip'].includes(tier);
  return tier === 'free';
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let client;
  try { client = sb(); } catch (e) { return res.status(500).json({ error: e.message }); }

  const user = await verifyToken(req);
  const { model_id, messages, session_id } = req.body || {};

  if (!model_id || !messages || !Array.isArray(messages))
    return res.status(400).json({ error: 'model_id dan messages wajib' });
  if (!messages.length)
    return res.status(400).json({ error: 'messages tidak boleh kosong' });

  const plan = effectivePlan(user);
  const tier = MODEL_TIERS[model_id] || 'free';
  if (!planAllows(plan, tier))
    return res.status(403).json({
      error: `Model ini membutuhkan paket ${tier === 'vip' ? 'VIP' : 'Premium'}`,
      upgrade_required: true,
    });

  const cfModel = CF_IDS[model_id] || CF_IDS['llama-8b'];

  // Demo mode jika CF tidak dikonfigurasi
  if (!CF_ACC || !CF_KEY) {
    const lastMsg = messages[messages.length - 1]?.content || '';
    const reply = `**[Demo Mode — CF AI tidak dikonfigurasi]**\n\nKamu bertanya: "${lastMsg.slice(0, 100)}"\n\nUntuk mengaktifkan AI, set \`CF_ACCOUNT_ID\` dan \`CF_API_TOKEN\` di environment variables Vercel.`;
    if (user && session_id) {
      await saveMessages(client, user, session_id, messages[messages.length - 1]?.content, reply, model_id);
    }
    return res.json({ response: reply, demo: true });
  }

  // Call Cloudflare Workers AI
  try {
    const fetch = require('node-fetch');
    const r = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${CF_ACC}/ai/run/${cfModel}`,
      {
        method:  'POST',
        headers: { Authorization: `Bearer ${CF_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [
            {
              role: 'system',
              content: 'Kamu adalah KizAi, asisten AI cerdas dan ramah buatan Indonesia. Jawab dalam Bahasa Indonesia kecuali diminta lain. Gunakan format Markdown untuk jawaban yang lebih jelas dan terstruktur. Selalu beri jawaban yang helpful, akurat, dan detail.',
            },
            ...messages.slice(-20),
          ],
          max_tokens: 2048,
        }),
        signal: AbortSignal.timeout(30000),
      }
    );
    const d = await r.json();
    if (!d.success) throw new Error(d.errors?.[0]?.message || 'Cloudflare AI error');

    const reply = d.result?.response || 'Maaf, tidak ada respons dari AI.';

    // Simpan ke Supabase
    if (user && session_id) {
      await saveMessages(client, user, session_id, messages[messages.length - 1]?.content, reply, model_id);
    }

    return res.json({ response: reply });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'AI tidak merespons' });
  }
};

async function saveMessages(client, user, session_id, userMsg, aiReply, model_id) {
  try {
    await client.from('chat_messages').insert([
      { session_id, user_id: user.id, role: 'user',      content: userMsg,  model_id },
      { session_id, user_id: user.id, role: 'assistant', content: aiReply,  model_id },
    ]);
    await client.from('chat_sessions').update({
      message_count: client.raw ? client.raw('message_count + 2') : undefined,
      last_message:  aiReply.slice(0, 120),
      updated_at:    new Date().toISOString(),
    }).eq('id', session_id);
    await client.from('profiles').update({
      chat_messages: (user.chat_messages || 0) + 1,
      xp:            (user.xp || 0) + 2,
    }).eq('id', user.id);
  } catch (e) {
    console.error('saveMessages error:', e.message);
  }
}
