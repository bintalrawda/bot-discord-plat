// index.js
require("dotenv").config();
const { Client, GatewayIntentBits } = require("discord.js");
const cron = require("node-cron");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

// -------------------- ENV --------------------
const PLATS_CHANNEL_ID = process.env.CHANNEL_ID;                // channel plats (notes sur photos)
const REMINDER_CHANNEL_ID = process.env.REMINDER_CHANNEL_ID;    // channel rappels (dhikr/ayah/hadith/adhkar)
const REMINDER_TIMES = (process.env.REMINDER_TIMES || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const MORNING_ADHKAR_TIME = process.env.MORNING_ADHKAR_TIME;    // ex "07:15"
const EVENING_ADHKAR_TIME = process.env.EVENING_ADHKAR_TIME;    // ex "18:30"
const TZ = process.env.TZ || "Europe/Brussels";

const HADITH_LANG_PREFIX = (process.env.HADITH_LANG_PREFIX || "fr,eng")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

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
      JSON.stringify(
        { usedAyahIds: [], usedDhikrIdx: [], usedHadithKeys: [] },
        null,
        2
      )
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

// -------------------- CONTENT (local) --------------------
function readJson(relPath) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, relPath), "utf-8"));
}

const dhikrList = readJson("content/dhikr.json");
const morningAdhkar = readJson("content/adhkar_morning.json");
const eveningAdhkar = readJson("content/adhkar_evening.json");

function pickNonRepeatingIndex(listLength, usedArrName) {
  const state = loadState();
  const used = state[usedArrName] || [];

  // Si tout a été utilisé -> reset (sinon impossible sur une liste finie)
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

// -------------------- PHOTO (plats): seulement upload --------------------
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

  // ✅ uniquement si photo envoyée depuis galerie/caméra (attachment)
  if (!hasUploadedImage(message)) return;

  try {
    for (const emoji of ratingEmojis) {
      await message.react(emoji);
    }
  } catch (err) {
    console.error("Erreur réactions :", err);
  }
});

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
    id = Math.floor(Math.random() * 6236) + 1; // 1..6236
  } while (used.has(id));

  const [ar, fr] = await Promise.all([
    axios.get(`https://api.alquran.cloud/v1/ayah/${id}/quran-uthmani`, { timeout: 15000 }),
    axios.get(`https://api.alquran.cloud/v1/ayah/${id}/fr.hamidullah`, { timeout: 15000 }),
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
    french: frData?.text,
  };
}

// -------------------- HADITH (énorme base via API + anti-répétition) --------------------
const HADITH_BASE = "https://cdn.jsdelivr.net/gh/fawazahmed0/hadith-api@1";

let hadithInfoCache = null;
let hadithInfoCacheAt = 0;

async function getHadithInfo() {
  const now = Date.now();
  if (hadithInfoCache && now - hadithInfoCacheAt < 24 * 60 * 60 * 1000) return hadithInfoCache;

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
    const match = editions.filter((e) => e.startsWith(`${pref}-`));
    if (match.length) return pickRandom(match);
  }
  return pickRandom(editions);
}

function getMaxHadithNumber(info, editionName) {
  const node = (info?.editions && info.editions[editionName]) || info?.[editionName] || {};
  // fallback si pas de count fiable
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

  // Retente pour éviter 404 / numéros manquants
  for (let tries = 0; tries < 60; tries++) {
    const hadithNo = Math.floor(Math.random() * maxNo) + 1;
    const key = `${editionName}|${hadithNo}`;
    if (state.usedHadithKeys.includes(key)) continue;

    try {
      const h = await fetchHadith(editionName, hadithNo);

      // Marque utilisé
      state.usedHadithKeys.push(key);

      // Limite de mémoire (fenêtre anti-répétition)
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
      continue; // si 404 => on retente
    }
  }

  throw new Error("Impossible de récupérer un hadith non répété.");
}

// -------------------- SENDERS --------------------
async function getReminderChannel() {
  if (!REMINDER_CHANNEL_ID) return null;
  return await client.channels.fetch(REMINDER_CHANNEL_ID).catch(() => null);
}

async function sendDailyReminder() {
  const channel = await getReminderChannel();
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

async function sendMorningAdhkar() {
  const channel = await getReminderChannel();
  if (!channel) return;

  const lines = morningAdhkar.map((x) => `• ${x}`).join("\n");
  await channel.send(`🌅 **Adhkār du matin**\n${lines}`);
}

async function sendEveningAdhkar() {
  const channel = await getReminderChannel();
  if (!channel) return;

  const lines = eveningAdhkar.map((x) => `• ${x}`).join("\n");
  await channel.send(`🌙 **Adhkār du soir**\n${lines}`);
}

// -------------------- SCHEDULER --------------------
function scheduleAt(timeStr, fn, label) {
  if (!timeStr) return;
  const [hh, mm] = timeStr.split(":").map(Number);
  if (Number.isNaN(hh) || Number.isNaN(mm)) {
    console.log(`⚠️ Heure invalide ignorée (${label}): ${timeStr}`);
    return;
  }
  const expr = `${mm} ${hh} * * *`;
  cron.schedule(
    expr,
    () => fn().catch((err) => console.error(`Erreur ${label}:`, err)),
    { timezone: TZ }
  );
  console.log(`✅ ${label} programmé à ${timeStr} (${TZ})`);
}

function startSchedules() {
  // Rappels dhikr/ayah/hadith aux heures demandées
  if (REMINDER_TIMES.length === 0) {
    console.log("ℹ️ REMINDER_TIMES vide → pas de rappel dhikr/ayah/hadith planifié.");
  } else {
    for (const t of REMINDER_TIMES) {
      scheduleAt(t, sendDailyReminder, "Rappel (Dhikr/Ayah/Hadith)");
    }
  }

  // Adhkar matin / soir
  scheduleAt(MORNING_ADHKAR_TIME, sendMorningAdhkar, "Adhkār matin");
  scheduleAt(EVENING_ADHKAR_TIME, sendEveningAdhkar, "Adhkār soir");
}

// -------------------- READY --------------------
client.once("clientReady", () => {
  console.log(`✅ Bot connecté : ${client.user.tag}`);
  startSchedules();
});

client.login(process.env.DISCORD_TOKEN);