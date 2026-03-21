'use strict';
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY || '';

function sb() {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Supabase tidak terkonfigurasi. Set SUPABASE_URL dan SUPABASE_SERVICE_KEY di environment variables.');
  return createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
}

const PLAN_RANKS = { free: 0, premium: 1, vip: 2 };
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
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  try {
    const { data: { user }, error } = await client.auth.getUser(token);
    if (error || !user) return null;
    const { data: profile } = await client.from('profiles').select('*').eq('id', user.id).single();
    if (!profile) return null;
    const plan = effectivePlan(profile);
    return { ...profile, email: user.email, effective_plan: plan, accessible_models: accessibleModels(plan) };
  } catch { return null; }
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Stream');
  res.setHeader('Access-Control-Max-Age',       '86400');
}

function rateLimit(map, key, limit = 10, windowMs = 60000) {
  const now = Date.now();
  const entry = map.get(key) || { count: 0, reset: now + windowMs };
  if (now > entry.reset) { entry.count = 0; entry.reset = now + windowMs; }
  entry.count++;
  map.set(key, entry);
  return entry.count <= limit;
}

module.exports = { sb, effectivePlan, accessibleModels, verifyToken, cors, rateLimit, PLAN_RANKS, MODEL_ACCESS };
