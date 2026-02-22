require("dotenv").config();
const { Client, GatewayIntentBits } = require("discord.js");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages, // suffit pour messageCreate
  ],
});

const TARGET_CHANNEL_ID = process.env.CHANNEL_ID;
const ratingEmojis = ["1️⃣","2️⃣","3️⃣","4️⃣","5️⃣","6️⃣","7️⃣","8️⃣","9️⃣","🔟"];

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (message.channel.id !== TARGET_CHANNEL_ID) return;

  try {
    for (const emoji of ratingEmojis) {
      await message.react(emoji);
    }
  } catch (err) {
    console.error("Erreur réactions :", err);
  }
});

client.once("ready", () => {
  console.log(`✅ Bot connecté : ${client.user.tag}`);
});

client.login(process.env.DISCORD_TOKEN);

