// Shared coupons store - used by both payment.js and admin.js
'use strict';
const COUPONS_STORE = [
  { code:'KIZAI10',   discount:0.10, active:true, uses:0 },
  { code:'HEMAT20',   discount:0.20, active:true, uses:0 },
  { code:'VIP30',     discount:0.30, active:true, uses:0 },
  { code:'PREMIUM50', discount:0.50, active:true, uses:0 },
  { code:'NEWUSER25', discount:0.25, active:true, uses:0 },
  { code:'FREE100',   discount:1.00, active:true, uses:0 },
];

module.exports = { COUPONS_STORE };
