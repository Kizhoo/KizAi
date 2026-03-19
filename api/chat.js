// api/chat.js
'use strict';
const { sb, verifyToken, effectivePlan, accessibleModels, cors } = require('../lib/supabase');

const CF_ACC = process.env.CF_ACCOUNT_ID || '';
const CF_KEY = process.env.CF_API_TOKEN   || '';
const MODEL_TIERS = { 'llama-8b':'free','deepseek-coder':'free','phi-3-mini':'free','llama-70b':'premium','mixtral':'premium','mistral-7b':'premium','qwen-72b':'vip','deepseek-r1':'vip','gemma-27b':'vip' };
const CF_IDS = { 'llama-8b':'@cf/meta/llama-3.1-8b-instruct','deepseek-coder':'@hf/thebloke/deepseek-coder-6.7b-instruct-awq','phi-3-mini':'@cf/microsoft/phi-2','llama-70b':'@cf/meta/llama-3.3-70b-instruct-fp8-fast','mixtral':'@cf/mistral/mistral-7b-instruct-v0.1','mistral-7b':'@cf/mistral/mistral-7b-instruct-v0.1','qwen-72b':'@cf/qwen/qwen2.5-72b-instruct','deepseek-r1':'@cf/deepseek-ai/deepseek-r1-distill-qwen-32b','gemma-27b':'@cf/google/gemma-7b-it' };
function planAllows(plan,tier){if(plan==='premium')return true;if(plan==='vip')return['free','vip'].includes(tier);return tier==='free'}

module.exports = async (req, res) => {
  cors(res);
  if(req.method==='OPTIONS') return res.status(200).end();
  if(req.method!=='POST') return res.status(405).json({error:'Method not allowed'});
  const client = sb();
  const user = await verifyToken(req);
  const { model_id, messages, session_id } = req.body || {};
  if(!model_id||!messages) return res.status(400).json({error:'model_id dan messages wajib'});
  const plan = effectivePlan(user);
  const tier = MODEL_TIERS[model_id]||'free';
  if(!planAllows(plan,tier)) return res.status(403).json({error:`Model ini butuh paket ${tier==='vip'?'VIP/Premium':'Premium'}`,upgrade_required:true});
  const cfModel = CF_IDS[model_id]||CF_IDS['llama-8b'];
  if(!CF_ACC||!CF_KEY){
    const last=messages[messages.length-1]?.content||'';
    const reply=`**[Demo Mode]** Kamu bilang: "${last.slice(0,80)}..."\n\nSet CF_ACCOUNT_ID dan CF_API_TOKEN untuk mengaktifkan KizAi AI.`;
    if(user&&session_id){await client.from('chat_messages').insert([{session_id,user_id:user.id,role:'user',content:messages[messages.length-1]?.content,model_id},{session_id,user_id:user.id,role:'assistant',content:reply,model_id}]);await client.from('profiles').update({chat_messages:(user.chat_messages||0)+1,xp:(user.xp||0)+2}).eq('id',user.id);}
    return res.json({response:reply,demo:true});
  }
  try{
    const fetch=require('node-fetch');
    const r=await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACC}/ai/run/${cfModel}`,{method:'POST',headers:{Authorization:`Bearer ${CF_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({messages:[{role:'system',content:'Kamu adalah KizAi, asisten AI yang cerdas dan ramah. Jawab dalam Bahasa Indonesia kecuali diminta lain. Gunakan markdown untuk format yang baik.'},...messages.slice(-20)],max_tokens:2048}),signal:AbortSignal.timeout(30000)});
    const d=await r.json();
    if(!d.success) throw new Error(d.errors?.[0]?.message||'CF AI error');
    const reply=d.result?.response||'Maaf, tidak ada respons.';
    if(user&&session_id){
      await client.from('chat_messages').insert([{session_id,user_id:user.id,role:'user',content:messages[messages.length-1]?.content,model_id},{session_id,user_id:user.id,role:'assistant',content:reply,model_id}]);
      await client.from('chat_sessions').update({message_count:client.raw('message_count+2'),last_message:reply.slice(0,100),updated_at:new Date().toISOString()}).eq('id',session_id);
      await client.from('profiles').update({chat_messages:(user.chat_messages||0)+1,xp:(user.xp||0)+2}).eq('id',user.id);
    }
    return res.json({response:reply});
  }catch(e){return res.status(500).json({error:e.message})}
};
