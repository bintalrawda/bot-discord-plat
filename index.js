require("dotenv").config();
const { Client, GatewayIntentBits } = require("discord.js");
const cron = require("node-cron");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

// -------------------- ENV --------------------
const PLATS_CHANNEL_ID = process.env.CHANNEL_ID;
const REMINDER_CHANNEL_ID = process.env.REMINDER_CHANNEL_ID;
const REMINDER_TIMES = (process.env.REMINDER_TIMES || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const TZ = process.env.TZ || "Europe/Brussels";

// -------------------- DISCORD --------------------
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

const ratingEmojis = ["1️⃣","2️⃣","3️⃣","4️⃣","5️⃣","6️⃣","7️⃣","8️⃣","9️⃣","🔟"];

// -------------------- STATE (anti-répétition) --------------------
const dataDir = path.join(__dirname, "data");
const statePath = path.join(dataDir, "state.json");

function ensureState() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(statePath)) {
    fs.writeFileSync(
      statePath,
      JSON.stringify({ usedAyahIds: [], usedDhikrIdx: [], usedHadithKeys: [] }, null, 2)
    );
  }
}
function loadState() {
  ensureState();
  return JSON.parse(fs.readFileSync(statePath, "utf-8"));
}
function saveState(state) {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

// -------------------- CONTENT --------------------
function readJson(relPath) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, relPath), "utf-8"));
}
const dhikrList = readJson("content/dhikr.json");

function pickNonRepeatingIndex(listLength, usedArrName) {
  const state = loadState();
  const used = state[usedArrName] || [];

  if (used.length >= listLength) {
    state[usedArrName] = [];
    saveState(state);
    return Math.floor(Math.random() * listLength);
  }

  let idx;
  do {
    idx = Math.floor(Math.random() * listLength);
  } while (used.includes(idx));

  used.push(idx);
  state[usedArrName] = used;
  saveState(state);
  return idx;
}

// -------------------- AYAH (anti-répétition) --------------------
async function getNonRepeatingAyah() {
  const state = loadState();
  const used = new Set(state.usedAyahIds || []);

  if (used.size >= 6236) {
    state.usedAyahIds = [];
    saveState(state);
    used.clear();
  }

  let id;
  do {
    id = Math.floor(Math.random() * 6236) + 1;
  } while (used.has(id));

  const [ar, fr] = await Promise.all([
    axios.get(`https://api.alquran.cloud/v1/ayah/${id}/quran-uthmani`),
    axios.get(`https://api.alquran.cloud/v1/ayah/${id}/fr.hamidullah`)
  ]);

  state.usedAyahIds = [...used, id];
  saveState(state);

  const arData = ar.data?.data;
  const frData = fr.data?.data;

  return {
    arabic: arData?.text,
    surahNumber: arData?.surah?.number,
    surah: arData?.surah?.englishName,
    ayahNumberInSurah: arData?.numberInSurah,
    french: frData?.text
  };
}

// -------------------- HADITH (illimité via API) --------------------
const HADITH_BASE = "https://cdn.jsdelivr.net/gh/fawazahmed0/hadith-api@1";
const HADITH_LANG_PREFIX = (process.env.HADITH_LANG_PREFIX || "fr,eng")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

let hadithInfoCache = null;
let hadithInfoCacheAt = 0;

async function getHadithInfo() {
  const now = Date.now();
  if (hadithInfoCache && (now - hadithInfoCacheAt) < 24 * 60 * 60 * 1000) return hadithInfoCache;
  const { data } = await axios.get(`${HADITH_BASE}/info.min.json`, { timeout: 15000 });
  hadithInfoCache = data;
  hadithInfoCacheAt = now;
  return data;
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function pickEdition(info) {
  const editions = Object.keys(info?.editions || info || {});
  if (!editions.length) return null;

  for (const pref of HADITH_LANG_PREFIX) {
    const match = editions.filter(e => e.startsWith(`${pref}-`));
    if (match.length) return pickRandom(match);
  }
  return pickRandom(editions);
}

function getMaxHadithNumber(info, editionName) {
  const node = (info?.editions && info.editions[editionName]) || info?.[editionName] || {};
  return node?.hadiths || node?.count || node?.total || 5000;
}

async function fetchHadith(editionName, hadithNo) {
  const url = `${HADITH_BASE}/editions/${editionName}/${hadithNo}.min.json`;
  const { data } = await axios.get(url, { timeout: 15000 });
  return data;
}

async function getNonRepeatingHadith() {
  const state = loadState();
  state.usedHadithKeys = state.usedHadithKeys || [];

  const info = await getHadithInfo();
  const editionName = pickEdition(info);
  if (!editionName) throw new Error("Aucune édition hadith trouvée.");

  const maxNo = getMaxHadithNumber(info, editionName);

  for (let tries = 0; tries < 60; tries++) {
    const hadithNo = Math.floor(Math.random() * maxNo) + 1;
    const key = `${editionName}|${hadithNo}`;
    if (state.usedHadithKeys.includes(key)) continue;

    try {
      const h = await fetchHadith(editionName, hadithNo);

      state.usedHadithKeys.push(key);
      if (state.usedHadithKeys.length > 20000) {
        state.usedHadithKeys = state.usedHadithKeys.slice(-20000);
      }
      saveState(state);

      const text =
        h?.hadiths?.[0]?.text ||
        h?.text ||
        h?.hadith?.text ||
        "Hadith indisponible.";

      const source =
        h?.hadiths?.[0]?.reference ||
        h?.reference ||
        editionName;

      return { text, source };
    } catch (e) {
      continue; // si numéro absent, on retente
    }
  }

  throw new Error("Impossible de récupérer un hadith non répété.");
}

// -------------------- DAILY MESSAGE --------------------
async function sendDailyReminder() {
  if (!REMINDER_CHANNEL_ID) return;
  const channel = await client.channels.fetch(REMINDER_CHANNEL_ID).catch(() => null);
  if (!channel) return;

  const dhikr = dhikrList[pickNonRepeatingIndex(dhikrList.length, "usedDhikrIdx")];
  const ayah = await getNonRepeatingAyah();
  const hadith = await getNonRepeatingHadith();

  const msg =
`🟩 **Rappel Dhikr**
• ${dhikr}

🟦 **Verset du jour**
**Sourate ${ayah.surahNumber} (${ayah.surah}) — Ayah ${ayah.ayahNumberInSurah}**
${ayah.arabic}
_${ayah.french}_

🟨 **Hadith**
_${hadith.text}_
— **${hadith.source}**`;

  await channel.send(msg);
}

// -------------------- PLATS: réactions uniquement si PHOTO upload --------------------
function hasUploadedImage(message) {
  if (!message.attachments || message.attachments.size === 0) return false;

  return message.attachments.some((att) => {
    const ct = att.contentType || "";
    const url = att.url || "";
    return ct.startsWith("image/") || /\.(png|jpe?g|gif|webp)$/i.test(url);
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

// -------------------- SCHEDULER --------------------
function startSchedules() {
  if (REMINDER_TIMES.length === 0) {
    console.log("ℹ️ REMINDER_TIMES vide → pas de rappels planifiés.");
    return;
  }

  for (const t of REMINDER_TIMES) {
    const [hh, mm] = t.split(":").map(Number);
    if (Number.isNaN(hh) || Number.isNaN(mm)) {
      console.log(`⚠️ Heure invalide ignorée: ${t}`);
      continue;
    }

    const expr = `${mm} ${hh} * * *`;
    cron.schedule(expr, () => {
      sendDailyReminder().catch(err => console.error("Erreur reminder:", err));
    }, { timezone: TZ });

    console.log(`✅ Rappel programmé à ${t} (${TZ})`);
  }
}

client.once("clientReady", () => {
  console.log(`✅ Bot connecté : ${client.user.tag}`);
  startSchedules();
});

client.login(process.env.DISCORD_TOKEN);