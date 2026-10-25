// SMS via mNotify (Ghana) and WhatsApp via Meta Cloud API. Both optional – skipped when keys are missing.
const normalize = p => { let d = String(p || '').replace(/\D/g, ''); if (d.startsWith('0') && d.length === 10) d = '233' + d.slice(1); return d; };

async function sms(to, text) {
  if (!process.env.MNOTIFY_API_KEY) return console.log('[sms skipped]', to, text);
  try {
    const r = await fetch('https://api.mnotify.com/api/sms/quick?key=' + encodeURIComponent(process.env.MNOTIFY_API_KEY), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: [normalize(to)], sender: process.env.MNOTIFY_SENDER_ID || 'Jofus', message: text, is_schedule: 'false', schedule_date: '' })
    });
    if (!r.ok) console.error('sms failed', r.status, await r.text());
  } catch (e) { console.error('sms error', e.message); }
}

async function whatsapp(to, text) {
  if (!process.env.WHATSAPP_TOKEN || !process.env.WHATSAPP_PHONE_ID) return console.log('[whatsapp skipped]', to, text);
  try {
    const r = await fetch(`https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_ID}/messages`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + process.env.WHATSAPP_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: normalize(to), type: 'text', text: { body: text } })
    });
    if (!r.ok) console.error('whatsapp failed', r.status, await r.text());
  } catch (e) { console.error('whatsapp error', e.message); }
}

async function both(to, text) { await Promise.all([sms(to, text), whatsapp(to, text)]); }

module.exports = { sms, whatsapp, both, normalize };
