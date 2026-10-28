// Load .env if present (no dependency needed)
try { require('fs').readFileSync(require('path').join(__dirname, '.env'), 'utf8').split('\n').forEach(l => { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*(#.*)?$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); }); } catch {}
const { createApp } = require('./lib/app');
const crypto = require('crypto');
const path = require('path');
const store = require('./lib/store');
const notify = require('./lib/notify');
notify.settingsProvider(() => store.load().then(db => db.settings));

const PORT = process.env.PORT || 3000;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const ADMIN_KEY = process.env.ADMIN_KEY || 'admin';
const PAYSTACK = process.env.PAYSTACK_SECRET_KEY || '';

// Static files from /public; the Paystack webhook gets the raw body for signature checks
const app = createApp({ staticDir: path.join(__dirname, 'public'), rawPaths: ['/api/paystack/webhook'] });

const LABELS = { pending_payment: 'Awaiting payment', placed: 'Order placed', accepted: 'Accepted', processing: 'Processing', ready: 'Ready', delivered: 'Delivered', completed: 'Completed', cancelled: 'Cancelled' };
const MESSAGES = {
  placed: (o, s) => `${s.businessName}: Thank you ${o.name}! Order ${o.id} (GHS ${o.amount}) received. Track it: ${BASE_URL}/track?id=${o.id}`,
  accepted: (o, s) => `${s.businessName}: Order ${o.id} has been accepted and will be prepared shortly.`,
  processing: (o, s) => `${s.businessName}: Order ${o.id} is being prepared.`,
  ready: (o, s) => o.fulfilment === 'delivery' ? `${s.businessName}: Order ${o.id} is out for delivery to ${o.address}. Please be reachable on this number.` : `${s.businessName}: Order ${o.id} is ready for pickup. ${s.pickupInfo || ''}`.trim(),
  delivered: (o, s) => `${s.businessName}: Order ${o.id} has been delivered. Please confirm here: ${BASE_URL}/track?id=${o.id}`,
  completed: (o, s) => `${s.businessName}: Order ${o.id} is complete. Thank you for shopping with us!`,
  cancelled: (o, s) => `${s.businessName}: Order ${o.id} has been cancelled. Call ${s.callPhone} if you have questions.`
};

const pub = o => ({ ...o, payment: { status: o.payment.status, method: o.payment.method } });
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'p';
const newId = () => 'JV-' + crypto.randomBytes(4).toString('hex').toUpperCase();

// ---------- public ----------
app.get('/api/config', async (req, res) => {
  const db = await store.load();
  const { businessName, tagline, deliveryFee, pickupInfo, footerNote, callPhone, whatsappPhone } = db.settings;
  const products = db.products.filter(p => p.active !== false).sort((a, b) => (a.sort || 0) - (b.sort || 0))
    .map(p => ({ ...p, image: (p.images && p.images[0]) || p.image || '' }));
  res.json({ businessName, tagline, deliveryFee: Number(deliveryFee) || 0, pickupInfo, footerNote, callPhone, whatsappPhone, paystack: !!PAYSTACK, products, storage: store.storageName() });
});

app.post('/api/orders', async (req, res) => {
  const db = await store.load();
  const b = req.body || {};
  const name = String(b.name || '').trim(), phone = String(b.phone || '').trim(), email = String(b.email || '').trim();
  if (!name || !/^\+?\d{9,15}$/.test(phone.replace(/[\s-]/g, ''))) return res.status(400).json({ error: 'Please enter your name and a valid phone number.' });
  const fulfilment = b.fulfilment === 'delivery' ? 'delivery' : 'pickup';
  const address = String(b.address || '').trim();
  if (fulfilment === 'delivery' && !address) return res.status(400).json({ error: 'Please enter a delivery address or landmark.' });
  const items = [];
  for (const it of (Array.isArray(b.items) ? b.items : [])) {
    const p = db.products.find(x => x.id === it.id && x.active !== false);
    const qty = Math.min(500, Math.max(0, parseInt(it.qty, 10) || 0));
    if (p && qty) items.push({ id: p.id, name: p.name + (p.size ? ' (' + p.size + ')' : ''), qty, price: Number(p.price) });
  }
  if (!items.length) return res.status(400).json({ error: 'Please choose at least one product.' });
  const deliveryFee = fulfilment === 'delivery' ? Number(db.settings.deliveryFee) || 0 : 0;
  const amount = Math.round((items.reduce((s, i) => s + i.qty * i.price, 0) + deliveryFee) * 100) / 100;

  const order = {
    id: newId(), createdAt: new Date().toISOString(), name, phone, email, items, fulfilment, address, note: String(b.note || '').slice(0, 500),
    deliveryFee, amount, status: PAYSTACK ? 'pending_payment' : 'placed',
    payment: { status: 'unpaid', method: PAYSTACK ? 'paystack' : 'on delivery', reference: null },
    history: [{ status: PAYSTACK ? 'pending_payment' : 'placed', at: new Date().toISOString() }]
  };
  db.orders.unshift(order);
  await store.save();
  alertOwner(order, db, PAYSTACK ? 'Customer is now paying via Paystack.' : 'Pay on pickup/delivery.'); // instant, not awaited

  if (PAYSTACK) {
    try {
      const r = await fetch('https://api.paystack.co/transaction/initialize', {
        method: 'POST', headers: { Authorization: 'Bearer ' + PAYSTACK, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email || `${phone.replace(/\D/g, '')}@customer.jofus.local`, amount: Math.round(amount * 100), currency: 'GHS', reference: order.id + '-' + Date.now(), callback_url: `${BASE_URL}/api/paystack/callback?id=${order.id}`, metadata: { orderId: order.id, name, phone } })
      });
      const d = await r.json();
      if (!d.status) throw new Error(d.message || 'Paystack error');
      order.payment.reference = d.data.reference; await store.save();
      return res.json({ ok: true, orderId: order.id, paymentUrl: d.data.authorization_url });
    } catch (e) {
      console.error('paystack init', e.message);
      return res.status(502).json({ error: 'Could not start payment. Please try again or call us.' });
    }
  }
  await announce(order, db);
  res.json({ ok: true, orderId: order.id, trackUrl: `/track?id=${order.id}` });
});

function alertOwner(order, db, payNote) {
  const lines = order.items.map(i => `${i.qty} x ${i.name}`).join(', ');
  const text = `NEW ORDER ${order.id}: ${order.name} (${order.phone}) - ${lines} - GHS ${order.amount} - ${order.fulfilment === 'delivery' ? 'Deliver to ' + order.address : 'Pickup'}${order.note ? ' - Note: ' + order.note : ''}. ${payNote} ${BASE_URL}/admin`;
  return notify.both(db.settings.ownerPhone, text).catch(e => console.error('owner alert', e.message));
}
async function announce(order, db) {
  const s = db.settings;
  notify.both(order.phone, MESSAGES.placed(order, s)).catch(() => {});
  if (order.payment.status === 'paid') alertOwner(order, db, `PAID GHS ${order.amount} via ${order.payment.method}.`);
}

async function markPaid(order, db, reference, method) {
  if (order.payment.status === 'paid') return;
  order.payment = { status: 'paid', method: method || order.payment.method, reference: reference || order.payment.reference, paidAt: new Date().toISOString() };
  if (order.status === 'pending_payment') { order.status = 'placed'; order.history.push({ status: 'placed', at: new Date().toISOString() }); await store.save(); await announce(order, db); }
  else await store.save();
}

async function verifyPaystack(reference) {
  const r = await fetch('https://api.paystack.co/transaction/verify/' + encodeURIComponent(reference), { headers: { Authorization: 'Bearer ' + PAYSTACK } });
  const d = await r.json();
  return d.status && d.data && d.data.status === 'success' ? d.data : null;
}

app.get('/api/paystack/callback', async (req, res) => {
  const db = await store.load();
  const order = db.orders.find(o => o.id === req.query.id);
  if (!order) return res.redirect('/track');
  try {
    const data = PAYSTACK && order.payment.reference ? await verifyPaystack(req.query.reference || order.payment.reference) : null;
    if (data && Math.round(order.amount * 100) === data.amount) { await markPaid(order, db, data.reference, 'paystack'); return res.redirect(`/track?id=${order.id}&paid=1`); }
  } catch (e) { console.error('callback verify', e.message); }
  res.redirect(`/track?id=${order.id}&paid=0`);
});

app.post('/api/paystack/webhook', async (req, res) => {
  if (!PAYSTACK) return res.sendStatus(200);
  const sig = crypto.createHmac('sha512', PAYSTACK).update(req.body).digest('hex');
  if (sig !== req.headers['x-paystack-signature']) return res.sendStatus(401);
  const ev = JSON.parse(req.body.toString());
  if (ev.event === 'charge.success') {
    const db = await store.load();
    const id = ev.data.metadata && ev.data.metadata.orderId;
    const order = db.orders.find(o => o.id === id || o.payment.reference === ev.data.reference);
    if (order && Math.round(order.amount * 100) === ev.data.amount) await markPaid(order, db, ev.data.reference, 'paystack');
  }
  res.sendStatus(200);
});

const samePhone = (a, b) => notify.normalize(a) === notify.normalize(b);

app.get('/api/orders/:id', async (req, res) => {
  const db = await store.load();
  const o = db.orders.find(x => x.id === String(req.params.id).toUpperCase());
  if (!o || !samePhone(o.phone, req.query.phone)) return res.status(404).json({ error: 'No order found with that number and phone. Check both and try again.' });
  const s = db.settings;
  res.json({ ...pub(o), ownerPhone: s.callPhone, ownerWhatsApp: s.whatsappPhone, businessName: s.businessName });
});

// All orders for a phone number (customer's order history)
app.get('/api/my-orders', async (req, res) => {
  const db = await store.load(); const phone = String(req.query.phone || '');
  if (notify.normalize(phone).length < 9) return res.status(400).json({ error: 'Enter the phone number you ordered with.' });
  const list = db.orders.filter(o => samePhone(o.phone, phone)).map(o => ({ id: o.id, createdAt: o.createdAt, status: o.status, label: LABELS[o.status] || o.status, amount: o.amount, deliveryFee: o.deliveryFee, fulfilment: o.fulfilment, address: o.address, items: o.items, payment: { status: o.payment.status } }));
  res.json({ ok: true, orders: list });
});

app.post('/api/orders/:id/confirm', async (req, res) => {
  const db = await store.load();
  const o = db.orders.find(x => x.id === String(req.params.id).toUpperCase());
  if (!o || !samePhone(o.phone, req.body && req.body.phone)) return res.status(404).json({ error: 'Order not found.' });
  if (!['ready', 'delivered'].includes(o.status)) return res.status(400).json({ error: 'This order cannot be confirmed yet.' });
  o.status = 'completed'; o.history.push({ status: 'completed', at: new Date().toISOString(), by: 'customer' });
  await store.save();
  notify.both(db.settings.ownerPhone, `Order ${o.id} confirmed as received by ${o.name}.`);
  res.json({ ok: true, order: pub(o) });
});

// ---------- admin ----------
// Password model: the dashboard password lives in settings (hashed) and can be changed or reset from the
// dashboard. The ADMIN_KEY env var is a master key that always works, so the owner can never be locked out.
const safeEq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const hashPw = (pw, salt) => crypto.scryptSync(String(pw), salt, 32).toString('hex');
const setPassword = (db, pw) => { const salt = crypto.randomBytes(8).toString('hex'); db.settings.adminSalt = salt; db.settings.adminHash = hashPw(pw, salt); };
const checkPassword = (db, k) => {
  if (!k) return false;
  if (safeEq(k, ADMIN_KEY)) return true;
  if (db.settings.adminHash) return safeEq(hashPw(k, db.settings.adminSalt), db.settings.adminHash);
  return false;
};
const auth = async (req, res, next) => {
  const db = await store.load();
  if (!checkPassword(db, req.headers['x-admin-key'] || '')) return res.status(401).json({ error: 'Wrong password' });
  next();
};
const publicSettings = s => { const { adminHash, adminSalt, resetCode, mnotifyApiKey, ...rest } = s; return { ...rest, mnotifyKeySet: !!(mnotifyApiKey || process.env.MNOTIFY_API_KEY), mnotifyKeySource: mnotifyApiKey ? 'settings' : (process.env.MNOTIFY_API_KEY ? 'render' : 'none') }; };

// Change password (logged in)
app.post('/api/admin/password', auth, async (req, res) => {
  const db = await store.load(); const pw = String(req.body.password || '');
  if (pw.length < 6) return res.status(400).json({ error: 'Use at least 6 characters.' });
  setPassword(db, pw); await store.save(); res.json({ ok: true });
});

// Forgot password: step 1 – send a 6-digit code to the owner's phone (SMS + WhatsApp). Valid 15 minutes.
const resetAttempts = new Map();
app.post('/api/admin/forgot', async (req, res) => {
  const db = await store.load();
  const last = db.settings.resetCode && db.settings.resetCode.sentAt ? Date.parse(db.settings.resetCode.sentAt) : 0;
  if (Date.now() - last < 60 * 1000) return res.status(429).json({ error: 'A code was sent less than a minute ago. Please wait before requesting another.' });
  const code = String(crypto.randomInt(100000, 999999));
  db.settings.resetCode = { hash: crypto.createHash('sha256').update(code).digest('hex'), expires: new Date(Date.now() + 15 * 60 * 1000).toISOString(), sentAt: new Date().toISOString() };
  await store.save();
  const msg = `${db.settings.businessName} dashboard: your password reset code is ${code}. It expires in 15 minutes. Ignore this if you did not request it.`;
  await notify.both(db.settings.ownerPhone, msg);
  const smsOn = !!process.env.MNOTIFY_API_KEY, waOn = !!(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_ID);
  if (!smsOn && !waOn) console.log('[password reset code]', code);
  const tail = String(db.settings.ownerPhone || '').slice(-4);
  res.json({ ok: true, sent: smsOn || waOn, hint: `number ending in ${tail}` });
});
// Forgot password: step 2 – verify the code and set a new password
app.post('/api/admin/reset', async (req, res) => {
  const db = await store.load(); const rc = db.settings.resetCode;
  const ip = req.socket.remoteAddress; const n = (resetAttempts.get(ip) || 0) + 1; resetAttempts.set(ip, n);
  if (n > 10) return res.status(429).json({ error: 'Too many attempts. Request a new code.' });
  const code = String(req.body.code || '').trim(), pw = String(req.body.password || '');
  if (!rc || Date.parse(rc.expires) < Date.now()) return res.status(400).json({ error: 'No active reset code. Request a new one.' });
  if (!safeEq(crypto.createHash('sha256').update(code).digest('hex'), rc.hash)) return res.status(400).json({ error: 'Wrong code.' });
  if (pw.length < 6) return res.status(400).json({ error: 'Use at least 6 characters.' });
  setPassword(db, pw); delete db.settings.resetCode; resetAttempts.delete(ip); await store.save();
  res.json({ ok: true });
});

app.get('/api/admin/orders', auth, async (req, res) => { const db = await store.load(); res.json({ orders: db.orders, settings: publicSettings(db.settings), labels: LABELS }); });
app.get('/api/admin/ping', auth, async (req, res) => { const db = await store.load(); const open = db.orders.filter(o => !['completed', 'cancelled'].includes(o.status)).length; res.json({ latest: db.orders[0] ? db.orders[0].createdAt : null, count: db.orders.length, open, recent: db.orders.slice(0, 5).map(o => ({ id: o.id, name: o.name, amount: o.amount, createdAt: o.createdAt, status: o.status, paid: o.payment.status === 'paid' })) }); });

const NEXT = { pending_payment: ['placed', 'cancelled'], placed: ['accepted', 'cancelled'], accepted: ['processing', 'cancelled'], processing: ['ready', 'cancelled'], ready: ['delivered', 'completed'], delivered: ['completed'], completed: [], cancelled: ['placed'] };
app.post('/api/admin/orders/:id/status', auth, async (req, res) => {
  const db = await store.load();
  const o = db.orders.find(x => x.id === req.params.id);
  if (!o) return res.status(404).json({ error: 'Order not found' });
  const st = req.body.status;
  if (!NEXT[o.status] || !NEXT[o.status].includes(st)) return res.status(400).json({ error: `Cannot move from ${LABELS[o.status]} to ${LABELS[st] || st}` });
  o.status = st; o.history.push({ status: st, at: new Date().toISOString(), by: 'owner' });
  await store.save();
  if (MESSAGES[st]) notify.both(o.phone, MESSAGES[st](o, db.settings));
  res.json({ ok: true, order: o });
});
app.post('/api/admin/orders/:id/mark-paid', auth, async (req, res) => {
  const db = await store.load();
  const o = db.orders.find(x => x.id === req.params.id);
  if (!o) return res.status(404).json({ error: 'Order not found' });
  await markPaid(o, db, null, 'cash/momo');
  res.json({ ok: true, order: o });
});

// Sales report: ?from=YYYY-MM-DD&to=YYYY-MM-DD (Africa/Accra = UTC). Counts paid orders + completed/delivered unpaid (cash) orders; excludes cancelled.
app.get('/api/admin/sales', auth, async (req, res) => {
  const db = await store.load();
  const day = d => new Date(d).toISOString().slice(0, 10);
  const today = day(Date.now());
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : today;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : from;
  const counts = o => o.status !== 'cancelled' && (o.payment.status === 'paid' || ['delivered', 'completed'].includes(o.status));
  const inRange = db.orders.filter(o => { const d = day(o.createdAt); return d >= from && d <= to; });
  const sales = inRange.filter(counts);
  const byDay = {}; const byItem = {};
  for (const o of sales) {
    const d = day(o.createdAt); byDay[d] = byDay[d] || { date: d, orders: 0, revenue: 0, items: 0, delivery: 0 };
    byDay[d].orders++; byDay[d].revenue += o.amount; byDay[d].delivery += o.deliveryFee || 0;
    for (const i of o.items) { byDay[d].items += i.qty; byItem[i.name] = byItem[i.name] || { name: i.name, qty: 0, revenue: 0 }; byItem[i.name].qty += i.qty; byItem[i.name].revenue += i.qty * i.price; }
  }
  const r2 = n => Math.round(n * 100) / 100;
  res.json({
    from, to,
    totals: { orders: sales.length, revenue: r2(sales.reduce((s, o) => s + o.amount, 0)), items: sales.reduce((s, o) => s + o.items.reduce((a, i) => a + i.qty, 0), 0), paidOnline: r2(sales.filter(o => o.payment.method === 'paystack' && o.payment.status === 'paid').reduce((s, o) => s + o.amount, 0)), pending: inRange.filter(o => !counts(o) && o.status !== 'cancelled').length, cancelled: inRange.filter(o => o.status === 'cancelled').length },
    days: Object.values(byDay).sort((a, b) => b.date.localeCompare(a.date)).map(d => ({ ...d, revenue: r2(d.revenue), delivery: r2(d.delivery) })),
    items: Object.values(byItem).sort((a, b) => b.revenue - a.revenue).map(i => ({ ...i, revenue: r2(i.revenue) })),
    orders: sales.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(o => ({ id: o.id, createdAt: o.createdAt, name: o.name, phone: o.phone, amount: o.amount, items: o.items, fulfilment: o.fulfilment, payment: o.payment.status, method: o.payment.method, status: LABELS[o.status] || o.status }))
  });
});

app.get('/api/admin/products', auth, async (req, res) => { const db = await store.load(); res.json(db.products.sort((a, b) => (a.sort || 0) - (b.sort || 0))); });
app.post('/api/admin/products', auth, async (req, res) => {
  const db = await store.load(); const b = req.body || {};
  if (!String(b.name || '').trim()) return res.status(400).json({ error: 'Product name is required' });
  if (!(Number(b.price) >= 0)) return res.status(400).json({ error: 'Enter a valid price' });
  const images = (Array.isArray(b.images) ? b.images : []).filter(u => typeof u === 'string' && (u.startsWith('data:image/') || u.startsWith('/') || u.startsWith('http'))).slice(0, 5);
  let p = b.id && db.products.find(x => x.id === b.id);
  if (!p) { p = { id: slug(b.name) + '-' + crypto.randomBytes(2).toString('hex'), sort: db.products.length + 1 }; db.products.push(p); }
  Object.assign(p, { name: String(b.name).trim(), category: String(b.category || 'General').trim(), price: Number(b.price), size: String(b.size || '').trim(), description: String(b.description || '').trim(), active: b.active !== false, images, image: images[0] || '' });
  await store.save(); res.json({ ok: true, product: p });
});
app.post('/api/admin/products/:id/toggle', auth, async (req, res) => {
  const db = await store.load(); const p = db.products.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Product not found' });
  p.active = typeof req.body.active === 'boolean' ? req.body.active : p.active === false;
  await store.save(); res.json({ ok: true, product: p });
});
app.delete('/api/admin/products/:id', auth, async (req, res) => { const db = await store.load(); db.products = db.products.filter(p => p.id !== req.params.id); await store.save(); res.json({ ok: true }); });

const SKEYS = ['businessName', 'tagline', 'ownerPhone', 'callPhone', 'whatsappPhone', 'deliveryFee', 'pickupInfo', 'footerNote', 'mnotifySenderId'];
app.get('/api/admin/settings', auth, async (req, res) => { const db = await store.load(); res.json(publicSettings(db.settings)); });
app.put('/api/admin/settings', auth, async (req, res) => {
  const db = await store.load();
  SKEYS.forEach(k => { if (k in req.body) db.settings[k] = k === 'deliveryFee' ? Number(req.body[k]) || 0 : String(req.body[k]).trim(); });
  db.settings.whatsappPhone = notify.normalize(db.settings.whatsappPhone);
  if (typeof req.body.mnotifyApiKey === 'string' && req.body.mnotifyApiKey.trim()) db.settings.mnotifyApiKey = req.body.mnotifyApiKey.trim();
  if (req.body.clearMnotifyKey) delete db.settings.mnotifyApiKey;
  await store.save(); res.json(publicSettings(db.settings));
});
app.post('/api/admin/sms-test', auth, async (req, res) => {
  const db = await store.load(); const to = String(req.body.to || db.settings.ownerPhone || '');
  const r = await notify.sms(to, `${db.settings.businessName}: test message from your order dashboard. SMS alerts are working.`);
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.json({ ok: true, to });
});
app.get('/api/admin/backup', auth, async (req, res) => { const db = await store.load(); res.setHeader('Content-Disposition', 'attachment; filename=jofus-backup.json'); res.json(db); });
app.post('/api/admin/restore', auth, async (req, res) => { const b = req.body; if (!b || !Array.isArray(b.products)) return res.status(400).json({ error: 'Not a valid backup file' }); await store.replace(b); res.json({ ok: true }); });

app.listen(PORT, () => console.log(`Jofus Ventures orders running on ${BASE_URL} (storage: ${store.storageName()})`));
