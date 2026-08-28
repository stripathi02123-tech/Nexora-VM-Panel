const { SlashCommandBuilder } = require('discord.js');

const commands = [
  new SlashCommandBuilder().setName('status').setDescription('Overall Nexora Cloud status across all nodes'),
  new SlashCommandBuilder().setName('nodes').setDescription('List all nodes and their current state'),
  new SlashCommandBuilder().setName('node').setDescription('Show detail for a single node')
    .addStringOption((o) => o.setName('name').setDescription('Node name').setRequired(true)),
  new SlashCommandBuilder().setName('ping').setDescription('Live latency check for a node')
    .addStringOption((o) => o.setName('node').setDescription('Node name').setRequired(true)),
  new SlashCommandBuilder().setName('vps').setDescription('Show detail for a VPS/VDS by ID')
    .addIntegerOption((o) => o.setName('id').setDescription('Server ID').setRequired(true)),
  new SlashCommandBuilder().setName('health').setDescription('Quick fleet health summary'),
  new SlashCommandBuilder().setName('uptime').setDescription('Uptime for every node'),
  new SlashCommandBuilder().setName('maintenance').setDescription('[Admin] Toggle maintenance mode for a node')
    .addStringOption((o) => o.setName('node').setDescription('Node name').setRequired(true))
    .addBooleanOption((o) => o.setName('enabled').setDescription('Enable maintenance mode (default: true)').setRequired(false)),
  new SlashCommandBuilder().setName('announce').setDescription('[Admin] Broadcast an announcement to all admins')
    .addStringOption((o) => o.setName('message').setDescription('Announcement text').setRequired(true)),
].map((c) => c.toJSON());

module.exports = { commands };
