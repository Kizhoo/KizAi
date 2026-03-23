'use strict';
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || '';

// Singleton client - created once, reused every request
let _client = null;

function sb() {
  if (!SUPABASE_URL || !SUPABASE_KEY)
    throw new Error('SUPABASE_URL dan SUPABASE_SERVICE_KEY belum diset di Railway Variables.');
  if (!_client) {
    _client = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return _client;
}

const PRICES = {
  premium: { 30: 19000, 90: 49000 },
  vip:     { 30: 39000, 90: 99000 },
};

const MODEL_ACCESS = {
  free:    ['llama-8b','deepseek-7b','phi3-mini','mistral-7b'],
  premium: ['llama-8b','deepseek-7b','phi3-mini','mistral-7b','llama-70b','mixtral-8x7b','deepseek-r1'],
  vip:     ['llama-8b','deepseek-7b','phi3-mini','mistral-7b','llama-70b','mixtral-8x7b','deepseek-r1','qwen-72b','gemma-27b','llama-405b'],
};

function effectivePlan(profile) {
  if (!profile) return 'free';
  if (profile.role === 'admin') return 'vip';
  const plan = profile.plan || 'free';
  if (plan === 'free') return 'free';
  const expires = profile.plan_expires ? new Date(profile.plan_expires) : null;
  if (!expires || expires > new Date()) return plan;
  return 'free';
}

function accessibleModels(plan) {
  return MODEL_ACCESS[plan] || MODEL_ACCESS.free;
}

async function verifyToken(client, authHeader) {
  if (!authHeader?.startsWith('Bearer ')) return null;
  try {
    const token = authHeader.slice(7);
    const { data: { user }, error } = await client.auth.getUser(token);
    if (error || !user) return null;
    const { data: profile } = await client.from('profiles').select('*').eq('id', user.id).single();
    if (!profile) return null;
    const plan = effectivePlan(profile);
    return { ...profile, email: user.email, effective_plan: plan, accessible_models: accessibleModels(plan) };
  } catch { return null; }
}

const _limits = new Map();
function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  const entry = _limits.get(key) || { count: 0, reset: now + windowMs };
  if (now > entry.reset) { entry.count = 0; entry.reset = now + windowMs; }
  entry.count++;
  _limits.set(key, entry);
  return entry.count <= limit;
}

module.exports = { sb, verifyToken, effectivePlan, accessibleModels, PRICES, MODEL_ACCESS, rateLimit };
