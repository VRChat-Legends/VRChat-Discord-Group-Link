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

const GROUP_LOG_CATEGORIES = [
  'default', 'warn', 'kick', 'ban', 'unban', 'join', 'leave',
  'join_request', 'invite', 'role', 'post', 'instance', 'group',
]

function groupLogChannels() {
  const raw = yml.group_logs?.channels || {}
  const channels = {}
  for (const key of GROUP_LOG_CATEGORIES) {
    channels[key] = String(raw[`${key}_channel_id`] || '').trim()
  }
  return channels
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

  // VRChat group audit log feed from config.yml (group_logs section).
  groupLogs: {
    pollSeconds: Math.max(30, int(yml.group_logs?.poll_seconds, 60)),
    channels: groupLogChannels(),
  },

  // Group post and join request feeds (feeds section).
  feeds: {
    pollSeconds: Math.max(60, int(yml.feeds?.poll_seconds, 300)),
    postsChannelId: String(yml.feeds?.posts_channel_id || '').trim(),
    joinRequestsChannelId: String(yml.feeds?.join_requests_channel_id || '').trim(),
  },

  // Moderation behaviour (moderation section).
  moderation: {
    caseThreads: yml.moderation?.case_threads !== false,
    allowActionsFromDiscord: yml.moderation?.allow_actions_from_discord !== false,
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

// Write channel ids into config.yml (comment preserving, section aware:
// role_channel_id exists under both logs: and group_logs:) and apply them
// to the running process so no restart is needed.
// assignments: [{ section: 'logs' | 'group_logs', key: 'warn_channel_id', id }]
function writeChannelIds(assignments) {
  const file = path.join(ROOT, 'config.yml')
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    text = ''
  }
  let section = ''
  const out = text.split(/\r?\n/).map((line) => {
    const top = line.match(/^([A-Za-z_]+):/)
    if (top) {
      section = top[1]
      return line
    }
    const kv = line.match(/^(\s+)([A-Za-z0-9_]+):.*$/)
    if (!kv) return line
    const hit = assignments.find((a) => a.section === section && a.key === kv[2])
    return hit ? `${kv[1]}${kv[2]}: "${hit.id}"` : line
  })
  fs.writeFileSync(file, out.join('\n'))

  const logsMap = {
    link_channel_id: 'linkChannelId',
    role_channel_id: 'roleChannelId',
    alert_channel_id: 'alertChannelId',
  }
  const feedsMap = {
    posts_channel_id: 'postsChannelId',
    join_requests_channel_id: 'joinRequestsChannelId',
  }
  for (const a of assignments) {
    if (a.section === 'logs' && logsMap[a.key]) config.logs[logsMap[a.key]] = String(a.id)
    if (a.section === 'feeds' && feedsMap[a.key]) config.feeds[feedsMap[a.key]] = String(a.id)
    if (a.section === 'group_logs') {
      const cat = a.key.replace(/_channel_id$/, '')
      if (cat in config.groupLogs.channels) config.groupLogs.channels[cat] = String(a.id)
    }
  }
}

module.exports = config
module.exports.validate = validate
module.exports.writeChannelIds = writeChannelIds
