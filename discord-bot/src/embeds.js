const { EmbedBuilder } = require('discord.js');

// Matches the panel's --accent (brass gold on graphite) so the bot reads as
// the same product, not a generic Discord-blurple embed.
const BRAND_COLOR = 0xc9974a;
const BRAND_LOGO_URL = process.env.NEXORA_LOGO_URL || null; // optional: a hosted copy of public/img/brand/mark.svg (or a PNG export of it)

function statusDot(status) {
  if (status === 'online') return '🟢';
  if (status === 'degraded') return '🟡';
  if (status === 'maintenance') return '🛠️';
  return '🔴';
}

function fmtPct(v) {
  if (v === null || v === undefined) return '—';
  return `${Math.round(v)}%`;
}

function fmtMs(v) {
  if (v === null || v === undefined) return '—';
  return `${Math.round(v)} ms`;
}

function fmtUptime(seconds) {
  if (!seconds) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  if (d > 0) return `${d}d ${h}h`;
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

function buildStatusEmbed(data, { panelName = 'Nexora Cloud' } = {}) {
  const embed = new EmbedBuilder()
    .setColor(BRAND_COLOR)
    .setAuthor(BRAND_LOGO_URL ? { name: panelName, iconURL: BRAND_LOGO_URL } : { name: panelName })
    .setTitle('Fleet Status')
    .setTimestamp(new Date(data.generated_at || Date.now()))
    .setFooter({ text: `${panelName} • updates automatically` });

  if (!data.nodes || data.nodes.length === 0) {
    embed.setDescription('No nodes configured yet.');
    return embed;
  }

  for (const n of data.nodes) {
    const ramPct = n.ram_mb ? Math.round(((n.ram_usage_mb || 0) / n.ram_mb) * 100) : null;
    const diskPct = n.storage_gb ? Math.round(((n.disk_usage_gb || 0) / n.storage_gb) * 100) : null;
    const lines = [
      `Ping: ${fmtMs(n.latency ? n.latency.current_ms : null)}`,
      `CPU: ${fmtPct(n.cpu_usage)}`,
      `RAM: ${ramPct === null ? '—' : `${ramPct}%`}`,
      `Disk: ${diskPct === null ? '—' : `${diskPct}%`}`,
      `VPS: ${n.counts?.vps ?? 0}  VDS: ${n.counts?.vds ?? 0}`,
    ];
    embed.addFields({
      name: `${statusDot(n.status)} ${n.name}${n.location ? ` — ${n.location}` : ''}`,
      value: lines.join('\n'),
      inline: true,
    });
  }

  embed.setDescription(`${data.vms.running}/${data.vms.total} servers running across ${data.nodes.length} node(s).`);
  return embed;
}

function buildNodeEmbed(node) {
  const ramPct = node.ram_mb ? Math.round(((node.ram_usage_mb || 0) / node.ram_mb) * 100) : null;
  const diskPct = node.storage_gb ? Math.round(((node.disk_usage_gb || 0) / node.storage_gb) * 100) : null;
  return new EmbedBuilder()
    .setColor(BRAND_COLOR)
    .setTitle(`${statusDot(node.status)} ${node.name}`)
    .setDescription(node.location || null)
    .addFields(
      { name: 'Status', value: node.status, inline: true },
      { name: 'Ping', value: fmtMs(node.latency ? node.latency.current_ms : null), inline: true },
      { name: 'Agent', value: node.agent_version || '—', inline: true },
      { name: 'CPU', value: `${fmtPct(node.cpu_usage)} of ${node.cpu_cores ?? '—'} cores`, inline: true },
      { name: 'RAM', value: ramPct === null ? '—' : `${ramPct}% of ${node.ram_mb} MB`, inline: true },
      { name: 'Disk', value: diskPct === null ? '—' : `${diskPct}% of ${node.storage_gb} GB`, inline: true },
      { name: 'VPS / VDS', value: `${node.counts?.vps ?? 0} / ${node.counts?.vds ?? 0}`, inline: true },
      { name: 'Last heartbeat', value: node.last_heartbeat_at || 'never', inline: true },
    )
    .setTimestamp(new Date());
}

function buildVpsEmbed(vps) {
  return new EmbedBuilder()
    .setColor(BRAND_COLOR)
    .setTitle(`${vps.resource_type === 'vds' ? 'VDS' : 'VPS'} #${vps.id} — ${vps.name}`)
    .addFields(
      { name: 'Status', value: vps.status, inline: true },
      { name: 'Running', value: vps.running ? 'Yes' : 'No', inline: true },
      { name: 'Uptime', value: fmtUptime(vps.uptime_seconds), inline: true },
      { name: 'CPU', value: `${vps.cpus} vCPU`, inline: true },
      { name: 'RAM', value: `${vps.memory} MB`, inline: true },
      { name: 'Disk', value: `${vps.disk_size}`, inline: true },
    )
    .setTimestamp(new Date());
}

module.exports = { buildStatusEmbed, buildNodeEmbed, buildVpsEmbed, statusDot, fmtMs, fmtPct, fmtUptime };
