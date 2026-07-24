'use strict'

// Configuration for VRChat-Discord Group Link. Everything comes from .env
// next to package.json. Copied and trimmed from the VRChat Legends API
// backend config, adapted for a standalone bot with no website.

const path = require('path')

require('dotenv').config({ path: path.join(__dirname, '..', '.env') })

function int(value, fallback) {
  const n = parseInt(value, 10)
  return Number.isFinite(n) ? n : fallback
}

const ROOT = path.join(__dirname, '..')

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
