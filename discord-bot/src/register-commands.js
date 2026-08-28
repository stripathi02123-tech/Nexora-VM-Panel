require('dotenv').config();
const { REST, Routes } = require('discord.js');
const { commands } = require('./commands');

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
const guildId = process.env.DISCORD_GUILD_ID;

if (!token || !clientId) {
  console.error('DISCORD_TOKEN and DISCORD_CLIENT_ID are required in discord-bot/.env');
  process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(token);

(async () => {
  try {
    const route = guildId
      ? Routes.applicationGuildCommands(clientId, guildId)
      : Routes.applicationCommands(clientId);
    await rest.put(route, { body: commands });
    console.log(`Registered ${commands.length} slash commands ${guildId ? `to guild ${guildId}` : 'globally'}.`);
  } catch (e) {
    console.error('Failed to register commands:', e);
    process.exit(1);
  }
})();
