'use strict';
const { sb, verifyToken, effectivePlan, cors } = require('../lib/supabase');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const user = await verifyToken(req);
  if (!user || user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  const client = sb();
  const action = req.query.action || '';

  if (req.method === 'GET' && action === 'stats') {
    const { data } = await client.from('admin_stats').select('*').single();
    const { data: plans } = await client.from('profiles').select('plan').neq('role','admin');
    const planCount = plans?.reduce((acc,p)=>{ acc[p.plan]=(acc[p.plan]||0)+1; return acc; },{});
    return res.json({ ...data, planCount });
  }

  if (req.method === 'GET' && action === 'users') {
    const page = parseInt(req.query.page)||1;
    const search = req.query.search||'';
    let query = client.from('profiles').select('*',{count:'exact'}).order('created_at',{ascending:false}).range((page-1)*20,page*20-1);
    if (search) query = query.or(`username.ilike.%${search}%`);
    const { data, count, error } = await query;
    return res.json({ users: data||[], total: count||0 });
  }

  if (req.method === 'GET' && action === 'orders') {
    const { data, count } = await client.from('orders').select('*',{count:'exact'}).order('created_at',{ascending:false}).limit(50);
    return res.json({ orders: data||[], total: count||0 });
  }

  if (req.method === 'PUT' && action === 'order') {
    const { order_id, status } = req.body||{};
    const { data: order } = await client.from('orders').select('*').eq('order_id',order_id).single();
    if (!order) return res.status(404).json({ error: 'Order tidak ditemukan' });
    await client.from('orders').update({ status }).eq('order_id', order_id);
    if (status === 'approved' && order.user_id) {
      const exp = new Date(Date.now() + order.duration*86400000).toISOString();
      await client.from('profiles').update({ plan: order.plan, plan_expires: exp }).eq('id', order.user_id);
    }
    return res.json({ message: 'Order diupdate' });
  }

  if (req.method === 'PUT' && action === 'user-plan') {
    const { user_id, plan, duration } = req.body||{};
    const updates = { plan };
    if (plan !== 'free' && duration) updates.plan_expires = new Date(Date.now()+duration*86400000).toISOString();
    await client.from('profiles').update(updates).eq('id', user_id);
    return res.json({ message: 'Plan diupdate' });
  }

  if (req.method === 'POST' && action === 'announce') {
    const { title, content, type } = req.body||{};
    const { data } = await client.from('announcements').insert({ title, content, type: type||'info', created_by: user.id }).select().single();
    return res.json({ announcement: data });
  }

  res.status(404).json({ error: 'Not found' });
};
