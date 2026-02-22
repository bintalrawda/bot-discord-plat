require("dotenv").config();
const { Client, GatewayIntentBits } = require("discord.js");
const cron = require("node-cron");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

// ================== ENV ==================
const PLATS_CHANNEL_ID = process.env.CHANNEL_ID;
const REMINDER_CHANNEL_ID = process.env.REMINDER_CHANNEL_ID;

const REMINDER_TIMES = (process.env.REMINDER_TIMES || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const MORNING_ADHKAR_TIME = process.env.MORNING_ADHKAR_TIME;
const EVENING_ADHKAR_TIME = process.env.EVENING_ADHKAR_TIME;

const TZ = process.env.TZ || "Europe/Brussels";
const HADITH_LANG_PREFIX = (process.env.HADITH_LANG_PREFIX || "fr,eng")
  .split(",")
  .map(s => s.trim());

// ================== DISCORD ==================
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

const ratingEmojis = ["1️⃣","2️⃣","3️⃣","4️⃣","5️⃣","6️⃣","7️⃣","8️⃣","9️⃣","🔟"];

// ================== STATE ==================
const dataDir = path.join(__dirname, "data");
const statePath = path.join(dataDir, "state.json");

function ensureState() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(statePath)) {
    fs.writeFileSync(statePath, JSON.stringify({
      usedAyahIds: [],
      usedDhikrIdx: [],
      usedHadithKeys: []
    }, null, 2));
  }
}

function loadState() {
  ensureState();
  return JSON.parse(fs.readFileSync(statePath));
}

function saveState(state) {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

// ================== CONTENT ==================
function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, file)));
}

const dhikrList = readJson("content/dhikr.json");
const morningAdhkar = readJson("content/adhkar_morning.json");
const eveningAdhkar = readJson("content/adhkar_evening.json");

// ================== PHOTO NOTES ==================
function hasUploadedImage(message) {
  if (!message.attachments || message.attachments.size === 0) return false;
  return message.attachments.some(att => {
    const ct = att.contentType || "";
    return ct.startsWith("image/");
  });
}

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (message.channel.id !== PLATS_CHANNEL_ID) return;
  if (!hasUploadedImage(message)) return;

  try {
    for (const emoji of ratingEmojis) {
      await message.react(emoji);
    }
  } catch (err) {
    console.error("Erreur réactions :", err);
  }
});

// ================== AYAH ==================
async function getNonRepeatingAyah() {
  const state = loadState();
  const used = new Set(state.usedAyahIds);

  let id;
  do {
    id = Math.floor(Math.random() * 6236) + 1;
  } while (used.has(id));

  const [ar, fr] = await Promise.all([
    axios.get(`https://api.alquran.cloud/v1/ayah/${id}/quran-uthmani`),
    axios.get(`https://api.alquran.cloud/v1/ayah/${id}/fr.hamidullah`)
  ]);

  state.usedAyahIds.push(id);
  saveState(state);

  return {
    arabic: ar.data.data.text,
    surah: ar.data.data.surah.englishName,
    surahNumber: ar.data.data.surah.number,
    ayahNumber: ar.data.data.numberInSurah,
    french: fr.data.data.text
  };
}

// ================== HADITH ILLIMITÉ ==================
const HADITH_BASE = "https://cdn.jsdelivr.net/gh/fawazahmed0/hadith-api@1";

async function getNonRepeatingHadith() {
  const state = loadState();
  state.usedHadithKeys ||= [];

  const { data: info } = await axios.get(`${HADITH_BASE}/info.min.json`);
  const editions = Object.keys(info.editions);

  let edition = editions.find(e => HADITH_LANG_PREFIX.some(pref => e.startsWith(pref))) 
                || editions[Math.floor(Math.random() * editions.length)];

  const max = info.editions[edition].hadiths || 5000;

  for (let i = 0; i < 60; i++) {
    const num = Math.floor(Math.random() * max) + 1;
    const key = `${edition}|${num}`;
    if (state.usedHadithKeys.includes(key)) continue;

    try {
      const { data } = await axios.get(`${HADITH_BASE}/editions/${edition}/${num}.min.json`);
      state.usedHadithKeys.push(key);
      saveState(state);

      return {
        text: data.hadiths?.[0]?.text || "Hadith indisponible.",
        source: data.hadiths?.[0]?.reference || edition
      };
    } catch {
      continue;
    }
  }
}

// ================== SENDERS ==================
async function getReminderChannel() {
  if (!REMINDER_CHANNEL_ID) return null;
  return await client.channels.fetch(REMINDER_CHANNEL_ID).catch(() => null);
}

async function sendDailyReminder() {
  const channel = await getReminderChannel();
  if (!channel) return;

  const dhikr = dhikrList[Math.floor(Math.random() * dhikrList.length)];
  const ayah = await getNonRepeatingAyah();
  const hadith = await getNonRepeatingHadith();

  await channel.send(
`🟢 **Dhikr**
• ${dhikr}

📖 **Verset**
Sourate ${ayah.surahNumber} (${ayah.surah}) - Ayah ${ayah.ayahNumber}
${ayah.arabic}
_${ayah.french}_

📜 **Hadith**
_${hadith.text}_
— ${hadith.source}`
  );
}

async function sendMorningAdhkar() {
  const channel = await getReminderChannel();
  if (!channel) return;

  const text = morningAdhkar.map(a => `• ${a}`).join("\n");
  await channel.send(`🌅 **Adhkār du matin**\n${text}`);
}

async function sendEveningAdhkar() {
  const channel = await getReminderChannel();
  if (!channel) return;

  const text = eveningAdhkar.map(a => `• ${a}`).join("\n");
  await channel.send(`🌙 **Adhkār du soir**\n${text}`);
}

// ================== SCHEDULER ==================
function scheduleAt(time, fn) {
  if (!time) return;
  const [hh, mm] = time.split(":").map(Number);
  const expr = `${mm} ${hh} * * *`;
  cron.schedule(expr, () => fn(), { timezone: TZ });
}

client.once("clientReady", () => {
  console.log(`✅ Bot connecté : ${client.user.tag}`);

  REMINDER_TIMES.forEach(t => scheduleAt(t, sendDailyReminder));
  scheduleAt(MORNING_ADHKAR_TIME, sendMorningAdhkar);
  scheduleAt(EVENING_ADHKAR_TIME, sendEveningAdhkar);
});

client.login(process.env.DISCORD_TOKEN);