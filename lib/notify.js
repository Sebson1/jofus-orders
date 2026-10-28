// SMS via mNotify (Ghana) and WhatsApp via Meta Cloud API. Both optional – skipped when keys are missing.
const normalize = p => { let d = String(p || '').replace(/\D/g, ''); if (d.startsWith('0') && d.length === 10) d = '233' + d.slice(1); return d; };

// mNotify credentials: dashboard Settings first, then Render env vars.
let getSettings = async () => ({});
function settingsProvider(fn) { getSettings = fn; }
async function smsConfig() {
  const s = await getSettings().catch(() => ({}));
  return { key: s.mnotifyApiKey || process.env.MNOTIFY_API_KEY || '', sender: s.mnotifySenderId || process.env.MNOTIFY_SENDER_ID || 'Jofus' };
}

async function sms(to, text) {
  const { key, sender } = await smsConfig();
  if (!key) { console.log('[sms skipped - no mNotify key]', to, text); return { ok: false, error: 'mNotify API key is not set. Add it under Settings → SMS alerts.' }; }
  const recipient = normalize(to);
  if (recipient.length < 9) return { ok: false, error: 'Invalid phone number: ' + to };
  try {
    const r = await fetch('https://api.mnotify.com/api/sms/quick?key=' + encodeURIComponent(key), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: [recipient], sender: sender.slice(0, 11), message: text, is_schedule: 'false', schedule_date: '' })
    });
    const body = await r.text();
    let j = {}; try { j = JSON.parse(body); } catch {}
    const ok = r.ok && (j.status === 'success' || j.code === '2000' || j.code === 2000);
    if (!ok) { console.error('sms failed', r.status, body.slice(0, 300)); return { ok: false, error: 'mNotify rejected the message: ' + (j.message || body.slice(0, 120) || r.status) }; }
    return { ok: true };
  } catch (e) { console.error('sms error', e.message); return { ok: false, error: e.message }; }
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

module.exports = { sms, whatsapp, both, normalize, settingsProvider };
