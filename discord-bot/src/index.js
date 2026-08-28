require('dotenv').config();
const { Client, GatewayIntentBits, PermissionsBitField } = require('discord.js');
const api = require('./api');
const state = require('./state');
const { buildStatusEmbed, buildNodeEmbed, buildVpsEmbed } = require('./embeds');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const STATUS_CHANNEL_ID = process.env.STATUS_CHANNEL_ID;
const STATUS_REFRESH_MS = parseInt(process.env.STATUS_REFRESH_MS || '60000', 10);
const ADMIN_ROLE_ID = process.env.ADMIN_ROLE_ID;

function isAdminInteraction(interaction) {
  if (!interaction.inGuild()) return false;
  if (interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) return true;
  if (ADMIN_ROLE_ID && interaction.member?.roles?.cache?.has(ADMIN_ROLE_ID)) return true;
  return false;
}

async function friendlyError(interaction, err) {
  const msg = err.response?.data?.error || err.message || 'Unknown error';
  const already = interaction.deferred || interaction.replied;
  const payload = { content: `⚠️ ${msg}`, ephemeral: true };
  if (already) return interaction.editReply(payload);
  return interaction.reply(payload);
}

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  try {
    switch (interaction.commandName) {
      case 'status': {
        await interaction.deferReply();
        const data = await api.status();
        await interaction.editReply({ embeds: [buildStatusEmbed(data, { panelName: data.panel_name })] });
        break;
      }
      case 'nodes': {
        await interaction.deferReply();
        const data = await api.nodes();
        const lines = data.nodes.map((n) => `${n.status === 'online' ? '🟢' : n.status === 'degraded' ? '🟡' : n.status === 'maintenance' ? '🛠️' : '🔴'} **${n.name}** — ${n.status}${n.location ? ` (${n.location})` : ''} — VPS ${n.counts?.vps ?? 0} / VDS ${n.counts?.vds ?? 0}`);
        await interaction.editReply(lines.join('\n') || 'No nodes configured yet.');
        break;
      }
      case 'node': {
        await interaction.deferReply();
        const name = interaction.options.getString('name', true);
        const data = await api.node(name);
        await interaction.editReply({ embeds: [buildNodeEmbed(data.node)] });
        break;
      }
      case 'ping': {
        await interaction.deferReply();
        const name = interaction.options.getString('node', true);
        const data = await api.ping(name);
        await interaction.editReply(
          `**${data.node}** (${data.status}) — ${data.latency_ms !== null ? `${Math.round(data.latency_ms)} ms` : 'no samples yet'}` +
          (data.avg_ms ? ` | avg ${Math.round(data.avg_ms)} ms, min ${Math.round(data.min_ms)} ms, max ${Math.round(data.max_ms)} ms` : '')
        );
        break;
      }
      case 'vps': {
        await interaction.deferReply();
        const id = interaction.options.getInteger('id', true);
        const data = await api.vps(id);
        await interaction.editReply({ embeds: [buildVpsEmbed(data.vps)] });
        break;
      }
      case 'health': {
        await interaction.deferReply();
        const data = await api.health();
        const emoji = data.ok ? '🟢' : '🔴';
        await interaction.editReply(`${emoji} ${data.nodes_online}/${data.nodes_total} nodes online` +
          (data.nodes_degraded ? `, ${data.nodes_degraded} degraded` : '') +
          (data.nodes_offline ? `, ${data.nodes_offline} offline` : ''));
        break;
      }
      case 'uptime': {
        await interaction.deferReply();
        const data = await api.uptime();
        const { fmtUptime } = require('./embeds');
        const lines = data.nodes.map((n) => `**${n.name}** — ${n.status === 'online' ? fmtUptime(n.uptime_seconds) : n.status}`);
        await interaction.editReply(lines.join('\n') || 'No nodes configured yet.');
        break;
      }
      case 'maintenance': {
        if (!isAdminInteraction(interaction)) return interaction.reply({ content: 'Admin only.', ephemeral: true });
        await interaction.deferReply();
        const node = interaction.options.getString('node', true);
        const enabled = interaction.options.getBoolean('enabled');
        const data = await api.maintenance(node, enabled === null ? true : enabled);
        await interaction.editReply(`🛠️ **${data.node}** is now **${data.status}**.`);
        break;
      }
      case 'announce': {
        if (!isAdminInteraction(interaction)) return interaction.reply({ content: 'Admin only.', ephemeral: true });
        await interaction.deferReply();
        const message = interaction.options.getString('message', true);
        await api.announce(message);
        await interaction.editReply(`📣 Announcement sent: ${message}`);
        break;
      }
      default:
        await interaction.reply({ content: 'Unknown command.', ephemeral: true });
    }
  } catch (err) {
    await friendlyError(interaction, err);
  }
});

// ---- Auto-updating status embed: edits one message instead of spamming ----
async function refreshStatusMessage() {
  if (!STATUS_CHANNEL_ID) return;
  try {
    const channel = await client.channels.fetch(STATUS_CHANNEL_ID);
    if (!channel || !channel.isTextBased()) return;

    const data = await api.status();
    const embed = buildStatusEmbed(data, { panelName: data.panel_name });
    const s = state.load();

    if (s.statusMessageId) {
      try {
        const msg = await channel.messages.fetch(s.statusMessageId);
        await msg.edit({ embeds: [embed] });
        return;
      } catch (_) {
        // Message was deleted or is otherwise unreachable — fall through and post a new one.
      }
    }

    const sent = await channel.send({ embeds: [embed] });
    state.save({ ...s, statusMessageId: sent.id });
  } catch (e) {
    console.error('[nexora-bot] status refresh failed:', e.response?.data?.error || e.message);
  }
}

client.once('ready', () => {
  console.log(`[nexora-bot] logged in as ${client.user.tag}`);
  if (STATUS_CHANNEL_ID) {
    refreshStatusMessage();
    setInterval(refreshStatusMessage, STATUS_REFRESH_MS);
  } else {
    console.log('[nexora-bot] STATUS_CHANNEL_ID not set — skipping live status embed.');
  }
});

client.login(process.env.DISCORD_TOKEN);
