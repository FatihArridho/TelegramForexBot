// ==============================================
// TELEGRAM FOREX SIGNAL BOT - FULL FIXED VERSION
// ==============================================
// fitur:
// - /buy & /sell (support foto + caption)
// - kirim ke channel + pin
// - DM semua owner
// - owner reply DM => reply ke pesan di channel
// - support gambar untuk hit/sl/tp
// - anti duplicate TP/Hit/SL
// - Signal ID detection 100% akurat
// - jurnal harian otomatis 23:30
// - multi owner
// ==============================================

require("dotenv").config();
const { Telegraf } = require("telegraf");
const fs = require("fs-extra");
const path = require("path");
const cron = require("node-cron");

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL = process.env.CHANNEL_USERNAME;
const OWNER_IDS_ENV = process.env.OWNER_IDS || "";
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "data.json");
const TIMEZONE = "Asia/Jakarta";
const DAILY_CRON = "11 23 * * *";

if (!BOT_TOKEN) throw new Error("BOT_TOKEN wajib di .env");

const bot = new Telegraf(BOT_TOKEN);

// =======================================
// DATABASE JSON
// =======================================
const db = {
  _data: { signals: [], journal: {}, owners: [] },

  async load() {
    if (await fs.pathExists(DATA_FILE)) {
      this._data = await fs.readJson(DATA_FILE);
    } else {
      const initial = {
        signals: [],
        journal: {},
        owners: OWNER_IDS_ENV.split(",")
          .map((x) => Number(x.trim()))
          .filter(Boolean),
      };
      this._data = initial;
      await this.save();
    }
  },

  async save() {
    await fs.writeJson(DATA_FILE, this._data, { spaces: 2 });
  },

  addSignal(sig) {
    this._data.signals.push(sig);
    return sig;
  },

  removeSignal(id) {
    this._data.signals = this._data.signals.filter((x) => x.id !== id);
  },

  getSignal(id) {
    return this._data.signals.find((x) => x.id === id);
  },

  isOwner(id) {
    return this._data.owners.includes(Number(id));
  },

  addOwner(id) {
    id = Number(id);
    if (!this._data.owners.includes(id)) {
      this._data.owners.push(id);
      return true;
    }
    return false;
  },

  removeOwner(id) {
    id = Number(id);
    const before = this._data.owners.length;
    this._data.owners = this._data.owners.filter((x) => x !== id);
    return this._data.owners.length !== before;
  },

  listOwners() {
    return this._data.owners;
  },

  addJournal(date, record) {
    if (!this._data.journal[date]) this._data.journal[date] = [];
    this._data.journal[date].push(record);
  },

  getJournal(date) {
    return this._data.journal[date] || [];
  },
};

// =======================================
// UTIL
// =======================================
const genId = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

const today = () => new Date().toISOString().slice(0, 10);

function parseCommandMessage(msg) {
  const txt = msg.caption?.trim() || msg.text?.trim();
  if (!txt) return null;

  const cleaned = txt.replace(/^\/(buy|sell)/i, "").replace(/\s+/g, "").trim();
  const parts = cleaned.split(",");

  if (parts.length < 3) return null;

  return {
    symbol: parts[0].toUpperCase(),
    entry: Number(parts[1]),
    stoploss: Number(parts[2]),
    tps: parts.slice(3, 8).map((x) => (x ? Number(x) : undefined)),
  };
}

function buildText(sig) {
  return (
    `${sig.symbol} ${sig.type === "buy" ? "Buy" : "Sell"} Limit\n` +
    `Entry: ${sig.entry}\n` +
    `Stop loss: ${sig.stoploss}\n` +
    sig.tps.map((x, i) => `Tp ${i + 1}: ${x || ""}`).join("\n") +
    `\n\nSignal ID: ${sig.id}`
  );
}

async function unpinAll() {
  try {
    await bot.telegram.unpinAllChatMessages(CHANNEL);
  } catch {}
}

// =======================================
// HANDLE NEW SIGNAL
// =======================================
async function handleNewSignal(ctx, type) {
  const parsed = parseCommandMessage(ctx.message);
  if (!parsed)
    return ctx.reply(
      "Format salah.\nContoh:\n/buy XAUUSD,4118,4115,4120,4122,4124,4126,4128\n(bisa caption foto)"
    );

  const sig = {
    id: genId(),
    type,
    symbol: parsed.symbol,
    entry: parsed.entry,
    stoploss: parsed.stoploss,
    tps: parsed.tps,
    hits: { entry: false, sl: false, tp: parsed.tps.map(() => false) },
    createdAt: new Date().toISOString(),
    posted: null,
  };

  const photo =
    ctx.message.photo?.[ctx.message.photo.length - 1]?.file_id || null;

  const text = buildText(sig);

  await unpinAll();

  // kirim ke channel
  let sent;
  if (photo)
    sent = await bot.telegram.sendPhoto(CHANNEL, photo, { caption: text });
  else sent = await bot.telegram.sendMessage(CHANNEL, text);

  await bot.telegram.pinChatMessage(CHANNEL, sent.message_id);

  sig.posted = { chatId: CHANNEL, messageId: sent.message_id };
  db.addSignal(sig);
  await db.save();

  // DM owner
  const ownerText = `New signal posted:\n\n${text}`;
  for (const oid of db.listOwners()) {
    await bot.telegram.sendMessage(oid, ownerText);
  }

  ctx.reply(`Signal posted (ID: ${sig.id})`);
}

bot.command("buy", (ctx) => handleNewSignal(ctx, "buy"));
bot.command("sell", (ctx) => handleNewSignal(ctx, "sell"));

// =======================================
// OWNER MANAGEMENT
// =======================================
bot.command("owners", (ctx) => {
  if (!db.isOwner(ctx.from.id)) return ctx.reply("Bukan owner.");
  ctx.reply("Owners:\n" + db.listOwners().join("\n"));
});

bot.command("addowner", async (ctx) => {
  if (!db.isOwner(ctx.from.id)) return ctx.reply("Bukan owner.");
  const id = ctx.message.text.replace("/addowner", "").trim();
  if (!id) return ctx.reply("format: /addowner <telegram_id>");
  const ok = db.addOwner(id);
  await db.save();
  ctx.reply(ok ? "Owner ditambah." : "Owner sudah ada.");
});

bot.command("removeowner", async (ctx) => {
  if (!db.isOwner(ctx.from.id)) return ctx.reply("Bukan owner.");
  const id = ctx.message.text.replace("/removeowner", "").trim();
  if (!id) return ctx.reply("format: /removeowner <telegram_id>");
  const ok = db.removeOwner(id);
  await db.save();
  ctx.reply(ok ? "Owner dihapus." : "Owner tidak ditemukan.");
});

// =======================================
// STATUS REPLY HANDLER
// =======================================
bot.on("message", async (ctx) => {
  if (ctx.chat.type !== "private") return;
  if (!db.isOwner(ctx.from.id)) return;

  const reply = ctx.message.reply_to_message;
  if (!reply) return;

  const combined = (reply.text || "") + "\n" + (reply.caption || "");
  const match = combined.match(/Signal ID:\s*([0-9a-zA-Z]+)/i);
  if (!match) return ctx.reply("Tidak menemukan Signal ID.");

  const id = match[1];
  const sig = db.getSignal(id);
  if (!sig) return ctx.reply("Signal tidak ditemukan.");

  const text = ctx.message.text?.trim().toLowerCase() || "";
  if (!text) return ctx.reply("Ketik perintah: hit, sl, tp1..tp5, cancel");

  const parts = text.split(/\s+/);
  const cmd = parts[0];
  const price = parts[1] ? Number(parts[1]) : undefined;

  const img =
    ctx.message.photo?.[ctx.message.photo.length - 1]?.file_id || null;

  function sendToChannel(msg) {
    if (img)
      return bot.telegram.sendPhoto(sig.posted.chatId, img, {
        caption: msg,
        reply_to_message_id: sig.posted.messageId,
      });

    return bot.telegram.sendMessage(sig.posted.chatId, msg, {
      reply_to_message_id: sig.posted.messageId,
    });
  }

  // ========= CANCEL =========
  if (cmd === "cancel") {
    await sendToChannel(`❌ Cancel\nSignal ID: ${sig.id}`);
    db.removeSignal(sig.id);
    await db.save();
    return ctx.reply("Signal di-cancel.");
  }

  // ========= HIT / SL / TP =========
  if (cmd === "hit") {
    if (sig.hits.entry) return ctx.reply("Entry sudah tercatat.");
    sig.hits.entry = true;
    await sendToChannel(`Hit ✅\n${price ? "Price: " + price : ""}\nSignal ID: ${sig.id}`);
  }

  if (cmd === "sl") {
    if (sig.hits.sl) return ctx.reply("SL sudah tercatat.");
    sig.hits.sl = true;
    await sendToChannel(`Stop Loss -1R\n${price ? "Price: " + price : ""}\nSignal ID: ${sig.id}`);
  }

  if (/^tp[1-5]$/.test(cmd)) {
    const tpIndex = Number(cmd.slice(2)) - 1;
    if (sig.hits.tp[tpIndex]) return ctx.reply(`TP ${tpIndex + 1} sudah tercatat.`);
    sig.hits.tp[tpIndex] = true;

    await sendToChannel(
      `Tp ${tpIndex + 1} ✅\n${price ? "Price: " + price : ""}\nSignal ID: ${sig.id}`
    );
  }

  db.updateSignal(sig.id, { hits: sig.hits });
  await db.save();

  ctx.reply("Status dikirim ke channel.");
});

// =======================================
// DAILY JOURNAL AUTOSEND
// =======================================
function formatJournal(date) {
  const list = db.getJournal(date);
  if (!list.length) return `Tidak ada jurnal di ${date}`;

  let txt = `Jurnal ${date}\n\n`;
  let profitR = 0;

  for (let i of list) {
    profitR += i.profitR;
    txt += `${i.symbol} ${i.action.toUpperCase()} | ${i.profitR.toFixed(
      2
    )} R\n`;
  }

  txt += `\nTotal: ${profitR.toFixed(2)} R`;
  return txt;
}

cron.schedule(
  DAILY_CRON,
  async () => {
    const d = today();
    const text = formatJournal(d);
    await bot.telegram.sendMessage(CHANNEL, text);
    for (const oid of db.listOwners()) {
      await bot.telegram.sendMessage(oid, text);
    }
  },
  { timezone: TIMEZONE }
);

// =======================================
// STARTUP
// =======================================
(async () => {
  await db.load();
  await bot.launch();
  console.log("BOT RUNNING...");
})();