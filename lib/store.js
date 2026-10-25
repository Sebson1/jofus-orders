// Storage: JSON file by default, Supabase (table "store") when SUPABASE_URL + SUPABASE_SERVICE_KEY are set.
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'db.json');

const DEFAULTS = {
  settings: {
    businessName: 'Jofus Ventures',
    tagline: 'Everything you need, delivered',
    ownerPhone: '0240000000',
    callPhone: '0240000000',
    whatsappPhone: '233240000000',
    deliveryFee: 20,
    pickupInfo: 'Pickup at our shop, Accra. Monday to Saturday, 8am to 7pm.',
    footerNote: 'Genuine products. Pay online or on delivery. Thank you for shopping with Jofus Ventures.'
  },
  products: [
    { id: 'rice-5kg', category: 'Consumables', name: 'Perfumed long-grain rice', size: '5kg', price: 95, description: 'Premium perfumed rice, clean and stone-free. Great for jollof and fried rice.', active: true, sort: 1, images: [] },
    { id: 'cooking-oil-3l', category: 'Consumables', name: 'Vegetable cooking oil', size: '3L', price: 78, description: 'Pure, cholesterol-free vegetable oil for frying and everyday cooking.', active: true, sort: 2, images: [] },
    { id: 'polo-shirt', category: 'Clothing', name: "Men's cotton polo shirt", size: 'S–XXL', price: 85, description: 'Breathable cotton polo in navy, black or white. Tell us your size and colour in the note.', active: true, sort: 3, images: [] },
    { id: 'ladies-dress', category: 'Clothing', name: "Ladies' casual dress", size: 'S–XL', price: 150, description: 'Light, comfortable everyday dress. State your size and preferred colour in the note.', active: true, sort: 4, images: [] },
    { id: 'sneakers', category: 'Footwear', name: 'Unisex sneakers', size: 'EU 36–45', price: 220, description: 'Comfortable everyday sneakers with cushioned sole. Add your shoe size in the note.', active: true, sort: 5, images: [] },
    { id: 'slides', category: 'Footwear', name: 'Rubber slides', size: 'EU 36–45', price: 60, description: 'Durable, easy-clean slides for home and outdoors.', active: true, sort: 6, images: [] },
    { id: 'blender', category: 'Kitchen appliances', name: '1.5L electric blender with grinder', size: '400W', price: 280, description: 'Two-speed blender with a dry-mill attachment for pepper, spices and beans.', active: true, sort: 7, images: [] },
    { id: 'rice-cooker', category: 'Kitchen appliances', name: 'Rice cooker', size: '1.8L', price: 240, description: 'Non-stick inner pot, keep-warm function, serves a family of 5.', active: true, sort: 8, images: [] },
    { id: 'earbuds', category: 'Electronics & accessories', name: 'Wireless earbuds', size: 'Bluetooth 5.3', price: 120, description: 'Clear sound, touch controls, charging case gives up to 24 hours of playback.', active: true, sort: 9, images: [] },
    { id: 'power-bank', category: 'Electronics & accessories', name: 'Power bank', size: '20,000mAh', price: 160, description: 'Fast-charging power bank with two USB outputs and a type-C input.', active: true, sort: 10, images: [] },
    { id: 'phone-charger', category: 'Electronics & accessories', name: 'Fast charger with type-C cable', size: '25W', price: 55, description: 'Fast charger for Android phones. Cable included.', active: true, sort: 11, images: [] }
  ],
  orders: []
};

// Supabase through its REST API (PostgREST) – no SDK needed.
const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const supabase = SB_URL && SB_KEY ? {
  headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json' },
  async select() {
    const r = await fetch(`${SB_URL}/rest/v1/store?select=key,value`, { headers: this.headers });
    if (!r.ok) throw new Error('Supabase: ' + r.status + ' ' + await r.text());
    return r.json();
  },
  async upsert(rows) {
    const r = await fetch(`${SB_URL}/rest/v1/store`, { method: 'POST', headers: { ...this.headers, Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows) });
    if (!r.ok) throw new Error('Supabase: ' + r.status + ' ' + await r.text());
  }
} : null;

let cache = null;
let writing = Promise.resolve();

async function load() {
  if (cache) return cache;
  if (supabase) {
    const data = await supabase.select();
    const map = Object.fromEntries((data || []).map(r => [r.key, r.value]));
    cache = { settings: { ...DEFAULTS.settings, ...(map.settings || {}) }, products: map.products || DEFAULTS.products, orders: map.orders || [] };
  } else {
    try { cache = JSON.parse(fs.readFileSync(FILE, 'utf8')); }
    catch { cache = JSON.parse(JSON.stringify(DEFAULTS)); }
    cache.settings = { ...DEFAULTS.settings, ...cache.settings };
    cache.products = cache.products || [];
    cache.orders = cache.orders || [];
  }
  return cache;
}

function save() {
  writing = writing.then(async () => {
    if (supabase) {
      const rows = ['settings', 'products', 'orders'].map(key => ({ key, value: cache[key], updated_at: new Date().toISOString() }));
      await supabase.upsert(rows);
    } else {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      const tmp = FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
      fs.renameSync(tmp, FILE);
    }
  }).catch(e => console.error('save failed:', e.message));
  return writing;
}

module.exports = {
  load, save, DEFAULTS,
  storageName: () => (supabase ? 'supabase' : 'file'),
  replace(state) { cache = { settings: { ...DEFAULTS.settings, ...(state.settings || {}) }, products: state.products || [], orders: state.orders || [] }; return save(); }
};
