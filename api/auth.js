'use strict';
const { sb, verifyToken, effectivePlan, accessibleModels, cors } = require('../lib/supabase');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const client = sb();
  const action = req.query.action || '';

  if (req.method === 'POST' && action === 'register') {
    const { username, email, password, telegram_id } = req.body || {};
    if (!username || !email || !password) return res.status(400).json({ error: 'Lengkapi semua field' });
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) return res.status(400).json({ error: 'Username: 3-20 karakter, huruf/angka/underscore' });
    if (password.length < 6) return res.status(400).json({ error: 'Password minimal 6 karakter' });
    const { data: ex } = await client.from('profiles').select('id').eq('username', username.toLowerCase()).maybeSingle();
    if (ex) return res.status(409).json({ error: 'Username sudah dipakai' });
    const { data, error } = await client.auth.admin.createUser({ email, password, user_metadata: { username: username.toLowerCase() }, email_confirm: true });
    if (error) return res.status(400).json({ error: error.message });
    await client.from('profiles').update({ username: username.toLowerCase(), telegram_id: telegram_id || '' }).eq('id', data.user.id);
    return res.json({ message: 'Akun berhasil dibuat! Silakan login.' });
  }

  if (req.method === 'POST' && action === 'login') {
    const { identifier, password } = req.body || {};
    if (!identifier || !password) return res.status(400).json({ error: 'Lengkapi semua field' });
    let email = identifier;
    if (!identifier.includes('@')) {
      const { data: p } = await client.from('profiles').select('id').eq('username', identifier.toLowerCase()).maybeSingle();
      if (!p) return res.status(401).json({ error: 'Username atau password salah' });
      const { data: u } = await client.auth.admin.getUserById(p.id);
      if (u?.user?.email) email = u.user.email;
    }
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) return res.status(401).json({ error: 'Username atau password salah' });
    const { data: profile } = await client.from('profiles').select('*').eq('id', data.user.id).single();
    const today = new Date().toISOString().split('T')[0];
    let streak = profile?.streak || 0;
    if (profile?.streak_last !== today) {
      const yest = new Date(Date.now() - 86400000).toISOString().split('T')[0];
      streak = profile?.streak_last === yest ? streak + 1 : 1;
      await client.from('profiles').update({ last_seen: new Date().toISOString(), streak, streak_last: today }).eq('id', data.user.id);
    }
    const plan = effectivePlan(profile);
    return res.json({ access_token: data.session.access_token, user: { ...profile, streak, email: data.user.email, effective_plan: plan, accessible_models: accessibleModels(plan) } });
  }

  if (req.method === 'GET' && action === 'me') {
    const user = await verifyToken(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const plan = effectivePlan(user);
    return res.json({ user: { ...user, effective_plan: plan, accessible_models: accessibleModels(plan) } });
  }

  if (req.method === 'PUT' && action === 'profile') {
    const user = await verifyToken(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const allowed = ['telegram_id','bio','avatar_color','avatar_emoji'];
    const updates = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
    if (req.body.preferences) {
      const { data: cur } = await client.from('profiles').select('preferences').eq('id', user.id).single();
      updates.preferences = { ...(cur?.preferences || {}), ...req.body.preferences };
    }
    const { data, error } = await client.from('profiles').update(updates).eq('id', user.id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    const plan = effectivePlan(data);
    return res.json({ user: { ...data, effective_plan: plan, accessible_models: accessibleModels(plan) } });
  }

  if (req.method === 'PUT' && action === 'change-password') {
    const user = await verifyToken(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const { newpass } = req.body || {};
    if (!newpass || newpass.length < 6) return res.status(400).json({ error: 'Password baru minimal 6 karakter' });
    const { error } = await client.auth.admin.updateUserById(user.id, { password: newpass });
    if (error) return res.status(400).json({ error: error.message });
    return res.json({ message: 'Password berhasil diubah' });
  }

  if (req.method === 'GET' && action === 'leaderboard') {
    const { data } = await client.from('leaderboard').select('*').limit(20);
    return res.json({ leaderboard: data || [] });
  }

  if (req.method === 'GET' && action === 'notifications') {
    const user = await verifyToken(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const { data } = await client.from('notifications').select('*').eq('user_id', user.id).order('created_at', { ascending: false }).limit(20);
    return res.json({ notifications: data || [] });
  }

  if (req.method === 'PUT' && action === 'read-notifications') {
    const user = await verifyToken(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    await client.from('notifications').update({ is_read: true }).eq('user_id', user.id);
    return res.json({ message: 'ok' });
  }

  if (req.method === 'GET' && action === 'bookmarks') {
    const user = await verifyToken(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const { data } = await client.from('bookmarks').select('*').eq('user_id', user.id).order('created_at', { ascending: false });
    return res.json({ bookmarks: data || [] });
  }

  if (req.method === 'POST' && action === 'bookmark') {
    const user = await verifyToken(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const { type, item_id, item_name, item_emoji, note } = req.body || {};
    const { data, error } = await client.from('bookmarks').upsert({ user_id: user.id, type, item_id, item_name, item_emoji, note }, { onConflict: 'user_id,type,item_id' }).select().single();
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ bookmark: data });
  }

  if (req.method === 'DELETE' && action === 'bookmark') {
    const user = await verifyToken(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const { type, item_id } = req.body || {};
    await client.from('bookmarks').delete().eq('user_id', user.id).eq('type', type).eq('item_id', item_id);
    return res.json({ message: 'Deleted' });
  }

  res.status(404).json({ error: 'Not found' });
};
