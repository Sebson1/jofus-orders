// Load .env if present (no dependency needed)
try { require('fs').readFileSync(require('path').join(__dirname, '.env'), 'utf8').split('\n').forEach(l => { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*(#.*)?$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); }); } catch {}
const { createApp } = require('./lib/app');
const crypto = require('crypto');
const path = require('path');
const store = require('./lib/store');
const notify = require('./lib/notify');

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
    .map(p => ({ ...p, image: (p.images && p.images[0]) || p.image || '/product.svg' }));
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

async function announce(order, db) {
  const s = db.settings;
  await notify.both(order.phone, MESSAGES.placed(order, s));
  const lines = order.items.map(i => `${i.qty} x ${i.name}`).join(', ');
  await notify.both(s.ownerPhone, `NEW ORDER ${order.id}: ${order.name} (${order.phone}) – ${lines} – GHS ${order.amount} – ${order.fulfilment === 'delivery' ? 'Deliver to ' + order.address : 'Pickup'}${order.note ? ' – Note: ' + order.note : ''}. Payment: ${order.payment.status}.`);
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
const auth = (req, res, next) => {
  const k = req.headers['x-admin-key'] || '';
  if (k.length !== ADMIN_KEY.length || !crypto.timingSafeEqual(Buffer.from(k), Buffer.from(ADMIN_KEY))) return res.status(401).json({ error: 'Wrong password' });
  next();
};

app.get('/api/admin/orders', auth, async (req, res) => { const db = await store.load(); res.json({ orders: db.orders, settings: db.settings, labels: LABELS }); });

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

const SKEYS = ['businessName', 'tagline', 'ownerPhone', 'callPhone', 'whatsappPhone', 'deliveryFee', 'pickupInfo', 'footerNote'];
app.get('/api/admin/settings', auth, async (req, res) => { const db = await store.load(); res.json(db.settings); });
app.put('/api/admin/settings', auth, async (req, res) => {
  const db = await store.load();
  SKEYS.forEach(k => { if (k in req.body) db.settings[k] = k === 'deliveryFee' ? Number(req.body[k]) || 0 : String(req.body[k]).trim(); });
  db.settings.whatsappPhone = notify.normalize(db.settings.whatsappPhone);
  await store.save(); res.json(db.settings);
});
app.get('/api/admin/backup', auth, async (req, res) => { const db = await store.load(); res.setHeader('Content-Disposition', 'attachment; filename=jofus-backup.json'); res.json(db); });
app.post('/api/admin/restore', auth, async (req, res) => { const b = req.body; if (!b || !Array.isArray(b.products)) return res.status(400).json({ error: 'Not a valid backup file' }); await store.replace(b); res.json({ ok: true }); });

app.listen(PORT, () => console.log(`Jofus Ventures orders running on ${BASE_URL} (storage: ${store.storageName()})`));
