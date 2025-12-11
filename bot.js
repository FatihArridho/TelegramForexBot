// bot.js
require('dotenv').config();
const { Telegraf } = require('telegraf');
const fs = require('fs-extra');
const path = require('path');
const cron = require('node-cron');

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL = process.env.CHANNEL_USERNAME || ''; // your Telegram channel
const OWNER_IDS_ENV = process.env.OWNER_IDS || ''; // comma-separated numeric ids
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const TIMEZONE = process.env.TIMEZONE || 'Asia/Jakarta';
const JOURNAL_SEND_CRON = process.env.JOURNAL_CRON || '30 23 * * *'; // default 23:30 daily

if (!BOT_TOKEN) throw new Error('BOT_TOKEN missing in .env');

const bot = new Telegraf(BOT_TOKEN);

// ---------- simple persistent storage using JSON ----------
const db = {
  _data: { signals: [], journal: {}, owners: [] },
  async load() {
    try {
      if (await fs.pathExists(DATA_FILE)) {
        this._data = await fs.readJson(DATA_FILE);
        // backward compatibility: if owners empty, fill from env
        if (!this._data.owners || !this._data.owners.length) {
          const fromEnv = OWNER_IDS_ENV.split(',').map(s => s.trim()).filter(Boolean).map(v => Number(v));
          if (fromEnv.length) this._data.owners = Array.from(new Set(fromEnv));
          await this.save();
        }
      } else {
        // initial owners from env
        const fromEnv = OWNER_IDS_ENV.split(',').map(s => s.trim()).filter(Boolean).map(v => Number(v));
        this._data.owners = Array.from(new Set(fromEnv));
        await this.save();
      }
    } catch (e) { console.error('db load failed', e); }
  },
  async save() {
    try { await fs.writeJson(DATA_FILE, this._data, { spaces: 2 }); }
    catch (e) { console.error('db save failed', e); }
  },
  addSignal(sig) { this._data.signals.push(sig); return sig; },
  updateSignal(id, obj) {
    const i = this._data.signals.findIndex(s => s.id === id);
    if (i === -1) return null;
    this._data.signals[i] = { ...this._data.signals[i], ...obj };
    return this._data.signals[i];
  },
  removeSignal(id) {
    this._data.signals = this._data.signals.filter(s => s.id !== id);
  },
  getSignalByPosted(chatId, messageId) {
    return this._data.signals.find(s => s.posted && s.posted.chatId === chatId && s.posted.messageId === messageId);
  },
  getSignalById(id) { return this._data.signals.find(s => s.id === id); },
  addJournal(date, entry) {
    if (!this._data.journal[date]) this._data.journal[date] = [];
    this._data.journal[date].push(entry);
  },
  getJournal(date) { return this._data.journal[date] || []; },

  // owners
  isOwner(id) { return this._data.owners.includes(Number(id)); },
  addOwner(id) {
    const n = Number(id);
    if (!this._data.owners.includes(n)) {
      this._data.owners.push(n);
      return true;
    }
    return false;
  },
  removeOwner(id) {
    const n = Number(id);
    const prevLen = this._data.owners.length;
    this._data.owners = this._data.owners.filter(x => x !== n);
    return this._data.owners.length !== prevLen;
  },
  listOwners() { return this._data.owners.slice(); }
};

// util
function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2,8); }
function todayStr() { return new Date().toISOString().slice(0,10); }
function buildSignalText(sig) {
  const lines = [];
  lines.push(`${sig.symbol} ${sig.type === 'buy' ? 'Buy' : 'Sell'} Limit`);
  lines.push(`Entry: ${sig.entry}`);
  lines.push(`Stop loss: ${sig.stoploss}`);
  sig.tps.forEach((t,i) => lines.push(`Tp ${i+1}: ${t !== undefined ? t : ''}`));
  lines.push(`\nSignal ID: ${sig.id}`);
  return lines.join('\n');
}
function parseArgs(text) {
  const cleaned = text.replace(/\s+/g,'').trim();
  const parts = cleaned.split(',');
  if (parts.length < 3) return null;
  const symbol = parts[0].toUpperCase();
  const entry = Number(parts[1]);
  const stoploss = Number(parts[2]);
  const tps = parts.slice(3, 8).map(v => v ? Number(v) : undefined);
  if (Number.isNaN(entry) || Number.isNaN(stoploss)) return null;
  return { symbol, entry, stoploss, tps };
}

// ---------- helper: unpin previous pinned message (if stored) ----------
async function safeUnpinPrevious(channel, prevMessageId) {
  try {
    if (!prevMessageId) {
      // try unpin all (newer telegram might support unpinAllChatMessages)
      // but to be safe, do nothing if no id
      return;
    }
    await bot.telegram.unpinChatMessage(channel, prevMessageId);
  } catch (e) {
    // ignore
    console.warn('unpin failed', e && e.message);
  }
}

// ---------- command handlers ----------
bot.start((ctx) => ctx.reply('bot siap. gunakan /buy atau /sell. owner dapat mengelola dengan /owners /addowner /removeowner'));

// check owner middleware
function ensureOwner(ctx) {
  const id = ctx.from && ctx.from.id;
  return id && db.isOwner(id);
}

// buy
bot.command('buy', async (ctx) => {
  const raw = ctx.message.text.replace('/buy','').trim();
  const parsed = parseArgs(raw);
  if (!parsed) return ctx.reply('format salah. contoh: /buy XAUUSD,4118,4115,4120,4122,4124,4126,4128');

  let photoFileId = null;
  if (ctx.message.photo && ctx.message.photo.length) {
    photoFileId = ctx.message.photo[ctx.message.photo.length -1].file_id;
  }

  const id = genId();
  const sig = {
    id,
    type: 'buy',
    symbol: parsed.symbol,
    entry: parsed.entry,
    stoploss: parsed.stoploss,
    tps: parsed.tps,
    createdAt: new Date().toISOString(),
    origin: { chatId: ctx.chat.id, messageId: ctx.message.message_id },
    posted: null,
    photoFileId,
    lastPinnedMessageId: null
  };
  db.addSignal(sig);
  await db.save();

  const caption = buildSignalText(sig);

  try {
    // unpin previous pinned message in channel if exists (store lastPinnedMessageId globally in data? we'll use last pinned per signal list)
    // for simplicity: try to unpin all pinned messages first (safe)
    try { await bot.telegram.unpinAllChatMessages(CHANNEL); } catch(e) { /* ignore if method not available */ }

    let sent;
    if (photoFileId) {
      sent = await bot.telegram.sendPhoto(CHANNEL, photoFileId, { caption });
    } else {
      sent = await bot.telegram.sendMessage(CHANNEL, caption);
    }

    // pin message
    try { await bot.telegram.pinChatMessage(CHANNEL, sent.message_id); } catch(e){ console.warn('pin failed', e && e.message); }

    // store posted info including pinned id
    sig.posted = { chatId: CHANNEL, messageId: sent.message_id };
    sig.lastPinnedMessageId = sent.message_id;
    db.updateSignal(id, { posted: sig.posted, lastPinnedMessageId: sig.lastPinnedMessageId });
    await db.save();

    // notify all owners by DM
    const owners = db.listOwners();
    const ownerMsg = `New signal posted to channel.\n\n${buildSignalText(sig)}`;
    for (const oid of owners) {
      try {
        if (photoFileId) {
          await bot.telegram.sendPhoto(oid, photoFileId, { caption: ownerMsg });
        } else {
          await bot.telegram.sendMessage(oid, ownerMsg);
        }
      } catch (e) {
        console.warn('notify owner failed', oid, e && e.message);
      }
    }

    await ctx.reply(`signal posted (id: ${id})`);
  } catch (e) {
    console.error('failed to send to channel', e);
    await ctx.reply('gagal mengirim ke channel: ' + (e.message || e));
  }
});

// sell
bot.command('sell', async (ctx) => {
  const raw = ctx.message.text.replace('/sell','').trim();
  const parsed = parseArgs(raw);
  if (!parsed) return ctx.reply('format salah. contoh: /sell XAUUSD,4118,4115,4120,4122,4124,4126,4128');

  let photoFileId = null;
  if (ctx.message.photo && ctx.message.photo.length) {
    photoFileId = ctx.message.photo[ctx.message.photo.length -1].file_id;
  }

  const id = genId();
  const sig = {
    id,
    type: 'sell',
    symbol: parsed.symbol,
    entry: parsed.entry,
    stoploss: parsed.stoploss,
    tps: parsed.tps,
    createdAt: new Date().toISOString(),
    origin: { chatId: ctx.chat.id, messageId: ctx.message.message_id },
    posted: null,
    photoFileId,
    lastPinnedMessageId: null
  };
  db.addSignal(sig);
  await db.save();

  const caption = buildSignalText(sig);

  try {
    try { await bot.telegram.unpinAllChatMessages(CHANNEL); } catch(e) { /* ignore */ }

    let sent;
    if (photoFileId) {
      sent = await bot.telegram.sendPhoto(CHANNEL, photoFileId, { caption });
    } else {
      sent = await bot.telegram.sendMessage(CHANNEL, caption);
    }
    try { await bot.telegram.pinChatMessage(CHANNEL, sent.message_id); } catch(e){ console.warn('pin failed', e && e.message); }

    sig.posted = { chatId: CHANNEL, messageId: sent.message_id };
    sig.lastPinnedMessageId = sent.message_id;
    db.updateSignal(id, { posted: sig.posted, lastPinnedMessageId: sig.lastPinnedMessageId });
    await db.save();

    const owners = db.listOwners();
    const ownerMsg = `New signal posted to channel.\n\n${buildSignalText(sig)}`;
    for (const oid of owners) {
      try {
        if (photoFileId) {
          await bot.telegram.sendPhoto(oid, photoFileId, { caption: ownerMsg });
        } else {
          await bot.telegram.sendMessage(oid, ownerMsg);
        }
      } catch (e) {
        console.warn('notify owner failed', oid, e && e.message);
      }
    }

    await ctx.reply(`signal posted (id: ${id})`);
  } catch (e) {
    console.error('failed to send to channel', e);
    await ctx.reply('gagal mengirim ke channel: ' + (e.message || e));
  }
});

// ---------- owner-only commands: manage owners ----------
bot.command('owners', async (ctx) => {
  // only owners can list
  if (!ensureOwner(ctx)) return ctx.reply('hanya owner yang bisa mengakses daftar owner.');
  const list = db.listOwners();
  return ctx.reply(`Owners:\n${list.join('\n') || '(tidak ada)'}`);
});

bot.command('addowner', async (ctx) => {
  if (!ensureOwner(ctx)) return ctx.reply('hanya owner yang bisa menambah owner.');
  const arg = ctx.message.text.replace('/addowner','').trim();
  if (!arg) return ctx.reply('format: /addowner <numeric_telegram_id>');
  const id = Number(arg);
  if (Number.isNaN(id)) return ctx.reply('id harus angka.');
  const ok = db.addOwner(id);
  await db.save();
  if (ok) return ctx.reply(`owner ${id} ditambahkan.`);
  return ctx.reply(`owner ${id} sudah ada.`);
});

bot.command('removeowner', async (ctx) => {
  if (!ensureOwner(ctx)) return ctx.reply('hanya owner yang bisa menghapus owner.');
  const arg = ctx.message.text.replace('/removeowner','').trim();
  if (!arg) return ctx.reply('format: /removeowner <numeric_telegram_id>');
  const id = Number(arg);
  if (Number.isNaN(id)) return ctx.reply('id harus angka.');
  const ok = db.removeOwner(id);
  await db.save();
  if (ok) return ctx.reply(`owner ${id} dihapus.`);
  return ctx.reply(`owner ${id} tidak ditemukan.`);
});

// ---------- owner replies handling (status updates) ----------
bot.on('message', async (ctx) => {
  try {
    // allow commands above; now handle status replies in private by owners
    if (ctx.chat.type !== 'private') return;
    const fromId = ctx.from && ctx.from.id;
    if (!fromId || !db.isOwner(fromId)) {
      // allow owners to use /journal here - handled by command
      return;
    }

    // if message is a reply to bot message that contains Signal ID
    const reply = ctx.message.reply_to_message;
    if (!reply) {
      // allow /journal command typed directly
      return;
    }

    const combined = (reply.text || '') + '\n' + (reply.caption || '');
    const m = combined.match(/Signal ID:\s*([0-9a-zA-Z]+)/i);
    if (!m) return ctx.reply('tidak menemukan Signal ID di pesan yang dibalas. Balas pesan DM bot yang berisi Signal ID.');

    const id = m[1];
    const sig = db.getSignalById(id);
    if (!sig) return ctx.reply('Signal tidak ditemukan atau sudah dihapus.');

    // parse owner's instruction text
    const text = (ctx.message.text || '').trim().toLowerCase();
    if (!text) {
      return;
    }
    const parts = text.split(/\s+/);
    const cmd = parts[0];
    const providedPrice = parts[1] ? Number(parts[1]) : undefined;

    // determine if image attached in owner reply
    let resultPhotoFileId = null;
    if (ctx.message.photo && ctx.message.photo.length) {
      resultPhotoFileId = ctx.message.photo[ctx.message.photo.length -1].file_id;
    }

    function computeResult(actionPrice) {
      const entry = sig.entry;
      const stop = sig.stoploss;
      let R = Math.abs(entry - stop);
      if (R === 0) R = 1;
      let profitPrice;
      if (sig.type === 'buy') profitPrice = actionPrice - entry;
      else profitPrice = entry - actionPrice;
      const profitR = profitPrice / R;
      return { R, profitPrice, profitR };
    }

    if (cmd === 'cancel') {
      try {
        await bot.telegram.sendMessage(sig.posted.chatId, `❌ Cancel\nSignal ID: ${sig.id}`);
      } catch (e) { console.warn('channel cancel fail', e && e.message); }
      db.removeSignal(id);
      await db.save();
      return ctx.reply('signal cancelled and removed.');
    }

    const isHit = cmd === 'hit';
    const isSL = cmd === 'sl';
    const isTP = /^tp[1-5]$/.test(cmd);

    if (!(isHit || isSL || isTP)) {
      return ctx.reply('perintah tidak dikenal. gunakan: cancel, hit, sl, tp1..tp5 (opsional tambahkan price). cont: "tp1 4120"');
    }

    const actionPrice = (!Number.isNaN(providedPrice) && providedPrice !== undefined) ? providedPrice : undefined;

    let replyText = '';
    if (isHit) replyText = 'Hit ✅';
    if (isSL) replyText = 'Stop Loss -1R';
    if (isTP) replyText = `Tp ${cmd.slice(2)} ✅`;
    if (actionPrice !== undefined) replyText += `\nPrice: ${actionPrice}`;
    replyText += `\nSignal ID: ${sig.id}`;

    try {
      if (resultPhotoFileId) {
        await bot.telegram.sendPhoto(sig.posted.chatId, resultPhotoFileId, { caption: replyText });
      } else {
        await bot.telegram.sendMessage(sig.posted.chatId, replyText);
      }
    } catch (e) { console.warn('channel reply fail', e && e.message); }

    if (actionPrice !== undefined) {
      const res = computeResult(actionPrice);
      const j = {
        id: sig.id,
        type: sig.type,
        symbol: sig.symbol,
        action: isHit ? 'hit' : isSL ? 'sl' : cmd,
        price: actionPrice,
        entry: sig.entry,
        stoploss: sig.stoploss,
        R: res.R,
        profitPrice: res.profitPrice,
        profitR: res.profitR,
        timestamp: new Date().toISOString()
      };
      db.addJournal(todayStr(), j);
      await db.save();
    }

    if (isSL || isHit || (isTP && cmd === 'tp5')) {
      db.removeSignal(id);
      await db.save();
    }

    return ctx.reply('ok, status dikirim ke channel.');
  } catch (err) {
    console.error('owner message handler error', err);
    try { await ctx.reply('terjadi error: ' + (err.message || err)); } catch(e) {}
  }
});

// ---------- /journal command (owner only, private) ----------
async function buildJournalText(date) {
  const items = db.getJournal(date);
  if (!items.length) return `Tidak ada jurnal untuk ${date}`;
  let text = `Jurnal ${date}\n\n`;
  let totalProfitR = 0;
  let totalProfitPrice = 0;
  let wins = 0;
  let losses = 0;
  items.forEach((it, i) => {
    text += `${i+1}. ${it.symbol} ${it.type.toUpperCase()} ${it.action.toUpperCase()} | entry ${it.entry} | price ${it.price} | R: ${it.profitR.toFixed(2)} | Pips: ${it.profitPrice}\n`;
    totalProfitR += it.profitR;
    totalProfitPrice += it.profitPrice;
    if (it.profitR > 0) wins++; else losses++;
  });
  text += `\nTotal trades: ${items.length}\nWins: ${wins}\nLosses: ${losses}\nTotal Profit (R): ${totalProfitR.toFixed(2)}\nTotal Profit (price): ${totalProfitPrice}\n`;
  return text;
}

bot.command('journal', async (ctx) => {
  if (ctx.chat.type !== 'private' || !db.isOwner(ctx.from && ctx.from.id)) {
    return ctx.reply('hanya owner yang bisa melihat jurnal via /journal.');
  }
  const text = await buildJournalText(todayStr());
  return ctx.reply(text);
});

// ---------- scheduled daily journal sender ----------
function scheduleDailyJournal() {
  try {
    cron.schedule(JOURNAL_SEND_CRON, async () => {
      try {
        const date = todayStr();
        const text = await buildJournalText(date);
        // send to channel
        try { await bot.telegram.sendMessage(CHANNEL, `Jurnal harian - ${date}\n\n${text}`); } catch(e){ console.warn('send daily journal to channel failed', e && e.message); }
        // also DM all owners
        const owners = db.listOwners();
        for (const oid of owners) {
          try { await bot.telegram.sendMessage(oid, `Jurnal harian - ${date}\n\n${text}`); } catch(e){ console.warn('dm journal failed', oid, e && e.message); }
        }
      } catch (e) {
        console.error('daily journal task error', e);
      }
    }, {
      scheduled: true,
      timezone: TIMEZONE
    });
    console.log('scheduled daily journal at cron "', JOURNAL_SEND_CRON, '" tz=', TIMEZONE);
  } catch (e) {
    console.error('scheduleDailyJournal error', e);
  }
}

// ---------- init ----------
(async () => {
  await db.load();
  bot.launch();
  scheduleDailyJournal();
  console.log('bot started');
})();

// graceful
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));