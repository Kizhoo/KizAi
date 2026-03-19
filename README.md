# ⚡ KizAi v2 — Supabase + Midtrans

## 🗄️ Setup Supabase

1. Buat project di https://supabase.com
2. Buka **SQL Editor** > **New Query**
3. Paste isi file `supabase-schema.sql`
4. Klik **Run**
5. Copy credentials dari **Settings > API**:
   - `SUPABASE_URL` = Project URL
   - `SUPABASE_ANON_KEY` = anon public
   - `SUPABASE_SERVICE_KEY` = service_role (**RAHASIA!**)

## 💳 Setup Midtrans

1. Daftar di https://midtrans.com
2. Dashboard > Sandbox > Settings > Access Keys
3. Copy Server Key & Client Key
4. **Ganti `YOUR_MIDTRANS_CLIENT_KEY`** di `public/checkout.html` baris script src

## 👑 Buat Admin Pertama

Setelah daftar akun, jalankan di Supabase SQL Editor:
```sql
UPDATE profiles SET role = 'admin' WHERE username = 'usernamu';
```
Setelah itu, tombol "Admin Dashboard" otomatis muncul di dashboard user.

## 🚀 Deploy ke Vercel

1. Push ke GitHub
2. Import di vercel.com
3. Set semua env dari `.env.example`
4. Deploy!

## 📱 40+ Fitur Web

Lihat `public/shared.js` untuk detail semua fitur yang tersedia.

## ✨ Stack

- **Frontend**: Vanilla JS, CSS Variables, Responsive
- **Auth**: Supabase Auth + JWT
- **Database**: Supabase (PostgreSQL) + RLS
- **Payment**: Midtrans Snap
- **AI**: Cloudflare Workers AI
- **Deploy**: Vercel
