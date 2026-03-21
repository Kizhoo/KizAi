'use strict';
const express = require('express');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

/* ── Middleware ── */
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// CORS — allow all
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

/* ── API Routes ── */
app.use('/api/auth',    require('./routes/auth'));
app.use('/api/chat',    require('./routes/chat'));
app.use('/api/payment', require('./routes/payment'));
app.use('/api/admin',   require('./routes/admin'));

/* ── Static Files ── */
const PUBLIC = path.join(__dirname, 'public');
app.use(express.static(PUBLIC, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.css') || filePath.endsWith('.js'))
      res.setHeader('Cache-Control', 'public, max-age=3600');
  },
}));

/* ── Pretty URLs (no .html extension) ── */
const PAGES = ['auth','chat','dashboard','checkout','tools','games','leaderboard','admin','admin-login'];
PAGES.forEach(page => {
  app.get(`/${page}`, (_, res) => res.sendFile(path.join(PUBLIC, `${page}.html`)));
});

/* ── Root ── */
app.get('/', (_, res) => res.sendFile(path.join(PUBLIC, 'index.html')));

/* ── 404 Fallback ── */
app.use((_, res) => res.status(404).sendFile(path.join(PUBLIC, 'index.html')));

/* ── Start ── */
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ KizAi v4 berjalan di port ${PORT}`);
  console.log(`   SUPABASE_URL : ${process.env.SUPABASE_URL ? '✅ Set' : '❌ Belum diset!'}`);
  console.log(`   CF_ACCOUNT_ID: ${process.env.CF_ACCOUNT_ID ? '✅ Set' : '⚠️  Belum diset (mode demo)'}`);
  console.log(`   IPAYMU_VA    : ${process.env.IPAYMU_VA ? '✅ Set' : '⚠️  Belum diset (payment disabled)'}`);
});
