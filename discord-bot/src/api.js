const axios = require('axios');

const baseURL = process.env.NEXORA_API_URL || 'http://localhost:3002/api/bot';
const apiKey = process.env.NEXORA_API_KEY;

if (!apiKey) {
  // eslint-disable-next-line no-console
  console.warn('[nexora-bot] WARNING: NEXORA_API_KEY is not set — API calls will fail with 401.');
}

const client = axios.create({
  baseURL,
  timeout: 8000,
  headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
});

// The bot never talks to QEMU/libvirt/the database directly — every command
// goes through the panel's authenticated, scoped REST API.
module.exports = {
  status: () => client.get('/status').then((r) => r.data),
  nodes: () => client.get('/nodes').then((r) => r.data),
  node: (name) => client.get(`/nodes/${encodeURIComponent(name)}`).then((r) => r.data),
  ping: (name) => client.get(`/ping/${encodeURIComponent(name)}`).then((r) => r.data),
  vps: (id) => client.get(`/vps/${encodeURIComponent(id)}`).then((r) => r.data),
  health: () => client.get('/health').then((r) => r.data),
  uptime: () => client.get('/uptime').then((r) => r.data),
  maintenance: (node, enabled) => client.post('/maintenance', { node, enabled }).then((r) => r.data),
  announce: (message) => client.post('/announce', { message }).then((r) => r.data),
};
