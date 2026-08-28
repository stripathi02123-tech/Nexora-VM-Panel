# Nexora Cloud Discord Bot

Read-only (plus two admin actions) Discord monitoring bot for a Nexora Cloud
panel. It talks **only** to the panel's REST API (`/api/bot/*`) — it never
touches QEMU/libvirt, the node agent, or the database directly.

## Setup

1. Create a Discord application + bot at https://discord.com/developers/applications,
   copy its token and application (client) ID.
2. In the Nexora admin panel, go to **Admin → API Keys** and create a key named
   e.g. `discord-bot` with scopes `status:read` (and `bot:admin` if you want
   `/maintenance` and `/announce` to work). Copy the raw key shown — it is
   only displayed once.
3. `cd discord-bot && cp .env.example .env` and fill in:
   - `DISCORD_TOKEN`, `DISCORD_CLIENT_ID` (and `DISCORD_GUILD_ID` for instant
     dev registration to one server)
   - `NEXORA_API_URL` — usually `http://<panel-host>:3002/api/bot`
   - `NEXORA_API_KEY` — the raw key from step 2
   - `STATUS_CHANNEL_ID` — channel where the live status embed should live
4. `npm install`
5. `npm run register` — registers the slash commands with Discord
6. `npm start`

## Commands

| Command | Description | Auth |
|---|---|---|
| `/status` | Full fleet status embed | anyone |
| `/nodes` | List all nodes | anyone |
| `/node <name>` | Detail for one node | anyone |
| `/ping <node>` | Live latency for a node | anyone |
| `/vps <id>` | Detail for one VPS/VDS | anyone |
| `/health` | Quick fleet health summary | anyone |
| `/uptime` | Uptime per node | anyone |
| `/maintenance <node> [enabled]` | Toggle maintenance mode | Discord Administrator or `ADMIN_ROLE_ID` |
| `/announce <message>` | Notify all panel admins | Discord Administrator or `ADMIN_ROLE_ID` |

## Live status embed

If `STATUS_CHANNEL_ID` is set, the bot posts one status embed on startup and
then **edits that same message** on an interval (`STATUS_REFRESH_MS`, default
60s) — it never spams a new message per refresh. The message ID is persisted
to `discord-bot/state.json` so it survives restarts.

## Security notes

- The bot key should carry only `status:read` (read-only) unless you actually
  want `/maintenance` and `/announce` to work — grant `bot:admin` deliberately.
- Restrict `/maintenance` and `/announce` further with `ADMIN_ROLE_ID` if you
  don't want every Discord Administrator able to use them.
- Revoke the key from **Admin → API Keys** any time to cut the bot off
  immediately; nothing else in the panel depends on it.
