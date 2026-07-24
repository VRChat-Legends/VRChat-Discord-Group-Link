'use strict'

// Configuration for VRChat-Discord Group Link. Secrets come from .env,
// non-secret settings (log channels, presence) from config.yml, both next
// to package.json. Copied and trimmed from the VRChat Legends API backend
// config, adapted for a standalone bot with no website.

const fs = require('fs')
const path = require('path')
const yaml = require('js-yaml')

require('dotenv').config({ path: path.join(__dirname, '..', '.env') })

function int(value, fallback) {
  const n = parseInt(value, 10)
  return Number.isFinite(n) ? n : fallback
}

const ROOT = path.join(__dirname, '..')

function loadYaml() {
  try {
    const parsed = yaml.load(fs.readFileSync(path.join(ROOT, 'config.yml'), 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

const yml = loadYaml()

const DEFAULT_PRESENCE = [
  { type: 'custom', text: '/link to connect your VRChat' },
  { type: 'watching', text: 'the group | /link' },
]

function presenceList() {
  const raw = Array.isArray(yml.presence) ? yml.presence : []
  const list = raw
    .map((p) => ({
      type: String(p?.type || 'custom').toLowerCase(),
      text: String(p?.text || '').slice(0, 128),
    }))
    .filter((p) => p.text)
  return list.length ? list : DEFAULT_PRESENCE
}

const config = {
  root: ROOT,
  dataDir: path.join(ROOT, 'data'),

  discord: {
    token: process.env.DISCORD_TOKEN || '',
    guildId: process.env.DISCORD_GUILD_ID || '',
  },

  vrchat: {
    email: process.env.VRCHAT_EMAIL || '',
    password: process.env.VRCHAT_PASSWORD || '',
    totpSecret: process.env.VRCHAT_TOTP_SECRET || '',
    authCookie: process.env.VRCHAT_AUTH_COOKIE || '',
    groupId: process.env.VRCHAT_GROUP_ID || '',
    cookiePath: path.join(ROOT, 'data', 'vrchat_cookies.json'),
    // Rate limit pacing: minimum gap between calls plus a per-minute cap.
    // VRChat has no published limits; these defaults stay far under what
    // the site itself uses and have proven safe in production.
    apiMinIntervalMs: Math.max(500, int(process.env.VRCHAT_MIN_INTERVAL_MS, 1000)),
    maxRequestsPerMinute: Math.min(60, Math.max(5, int(process.env.VRCHAT_MAX_REQUESTS_PER_MINUTE, 30))),
  },

  sync: {
    // Full auto-sync cadence. Discord channel renames are further limited
    // to once per ~6 minutes per channel by Discord itself; the tracker
    // module enforces that on top of this interval.
    intervalSeconds: Math.max(60, int(process.env.SYNC_INTERVAL_SECONDS, 300)),
  },

  // One-time link codes: how long a /link code stays valid.
  link: {
    codeTtlMinutes: 15,
  },

  // Discord log channels from config.yml (empty string disables a log).
  logs: {
    linkChannelId: String(yml.logs?.link_channel_id || '').trim(),
    roleChannelId: String(yml.logs?.role_channel_id || '').trim(),
    alertChannelId: String(yml.logs?.alert_channel_id || '').trim(),
  },

  // Rich presence rotation from config.yml.
  presence: presenceList(),

  log: {
    level: (process.env.LOG_LEVEL || 'info').toLowerCase(),
    toFile: process.env.LOG_TO_FILE !== '0',
    dir: path.join(ROOT, 'data', 'logs'),
  },
}

function validate() {
  const missing = []
  if (!config.discord.token) missing.push('DISCORD_TOKEN')
  if (!config.discord.guildId) missing.push('DISCORD_GUILD_ID')
  if (!config.vrchat.groupId) missing.push('VRCHAT_GROUP_ID')
  if (!config.vrchat.authCookie && (!config.vrchat.email || !config.vrchat.password)) {
    missing.push('VRCHAT_EMAIL + VRCHAT_PASSWORD (or VRCHAT_AUTH_COOKIE)')
  }
  return missing
}

module.exports = config
module.exports.validate = validate
