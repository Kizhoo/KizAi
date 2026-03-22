'use strict';

// Tangkap semua error agar server tidak crash
process.on('uncaughtException', (err) => console.error('CRASH PREVENTED:', err.message));
process.on('unhandledRejection', (r) => console.error('REJECTION:', r?.message || r));

const express = require('express');
const path    = require('path');
const app     = express();
const PORT    = process.env.PORT || 8080;

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

// CORS
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Health check — Railway uses this to confirm app is alive
app.get('/health', (_, res) => res.json({ ok: true }));
app.get('/ping',   (_, res) => res.send('pong'));

// API routes — wrapped in try/catch so 1 broken route doesn't kill the server
try {
  app.use('/api/auth',    require('./routes/auth'));
  app.use('/api/chat',    require('./routes/chat'));
  app.use('/api/payment', require('./routes/payment'));
  app.use('/api/admin',   require('./routes/admin'));
  console.log('✅ Routes loaded');
} catch (e) {
  console.error('❌ Route load error:', e.message);
  app.use('/api', (_, res) => res.status(500).json({ error: 'Server sedang dalam maintenance' }));
}

// Static files
const PUBLIC = path.join(__dirname, 'public');
app.use(express.static(PUBLIC));

// Pretty URLs
['auth','chat','dashboard','checkout','tools','games','leaderboard','admin','admin-login']
  .forEach(p => app.get(`/${p}`, (_, res) => res.sendFile(path.join(PUBLIC, `${p}.html`))));

app.get('/', (_, res) => res.sendFile(path.join(PUBLIC, 'index.html')));

// Error handler
app.use((err, req, res, next) => {
  console.error('Express error:', err.message);
  res.status(500).json({ error: 'Internal error' });
});

// 404 → index
app.use((_, res) => {
  try { res.sendFile(path.join(PUBLIC, 'index.html')); }
  catch { res.status(404).send('Not found'); }
});

// START — must bind to 0.0.0.0 on Railway
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚂 KizAi v4 running on PORT ${PORT}`);
  console.log(`   SUPABASE_URL: ${process.env.SUPABASE_URL ? '✅' : '❌ NOT SET'}`);
  console.log(`   SUPABASE_KEY: ${process.env.SUPABASE_SERVICE_KEY ? '✅' : '❌ NOT SET'}`);
  console.log(`   CF_AI:        ${process.env.CF_ACCOUNT_ID ? '✅' : '⚠️ demo'}`);
});
