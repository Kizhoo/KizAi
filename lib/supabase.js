'use strict';
const { createClient } = require('@supabase/supabase-js');

const SUPA_URL = process.env.SUPABASE_URL  || '';
const SUPA_SVC = process.env.SUPABASE_SERVICE_KEY || '';

function sb() {
  if (!SUPA_URL || !SUPA_SVC) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_KEY belum diset di environment variables');
  return createClient(SUPA_URL, SUPA_SVC, { auth: { persistSession: false } });
}

async function verifyToken(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : null;
  if (!token) return null;
  try {
    const client = sb();
    const { data: { user }, error } = await client.auth.getUser(token);
    if (error || !user) return null;
    const { data: profile } = await client.from('profiles').select('*').eq('id', user.id).single();
    return profile ? { ...profile, email: user.email } : null;
  } catch { return null; }
}

function effectivePlan(profile) {
  if (!profile || profile.plan === 'free') return 'free';
  if (!profile.plan_expires) return 'free';
  return new Date(profile.plan_expires) > new Date() ? profile.plan : 'free';
}

function accessibleModels(plan) {
  const F = ['llama-8b','deepseek-coder','phi-3-mini'];
  const P = ['llama-70b','mixtral','mistral-7b'];
  const V = ['qwen-72b','deepseek-r1','gemma-27b'];
  if (plan === 'premium') return [...F,...P,...V];
  if (plan === 'vip')     return [...F,...V];
  return F;
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
}

module.exports = { sb, verifyToken, effectivePlan, accessibleModels, cors };
