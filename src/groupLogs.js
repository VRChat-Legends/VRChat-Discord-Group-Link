'use strict'

// VRChat group audit log feed. Ported from the VRChat Legends website
// backend (services/groupAuditLogs.js) and upgraded for this bot:
//   - every event category gets its own channel in config.yml, with a
//     default channel catching anything unrouted instead of dropping it
//   - covers joins, leaves, join requests, invites, roles, posts, and
//     instances, not just warns, kicks, and bans
//   - actors and targets are cross referenced against linked accounts, so
//     the embed shows the matching Discord member when we know it
//   - watermark and seen ids live in sqlite (kv table), not a JSON file
//   - reuses the main bot client and the throttled VRChat API pacing, so
//     it can never hit the rate limit or need a second bot token

const config = require('./config')
const logger = require('./logger')
const db = require('./db')
const vrc = require('./vrchatApi')
const discordLog = require('./discordLog')

const log = logger('GroupLogs')

const KV_WATERMARK = 'audit_watermark'
const KV_SEEN = 'audit_seen_ids'
const SEEN_CAP = 600
const MAX_POSTS_PER_CYCLE = 40
const ALERT_COOLDOWN_MS = 60 * 60 * 1000

const CATEGORIES = {
  warn: { color: 0xffcc00, icon: '\u26a0\ufe0f' },
  kick: { color: 0xff8800, icon: '\ud83e\udd7e' },
  ban: { color: 0xe01b24, icon: '\ud83d\udd28' },
  unban: { color: 0x33d17a, icon: '\ud83d\udd4a\ufe0f' },
  join: { color: 0x2bcf5c, icon: '\ud83d\udce5' },
  leave: { color: 0x9a9996, icon: '\ud83d\udce4' },
  join_request: { color: 0x62a0ea, icon: '\ud83d\udce8' },
  invite: { color: 0xb5835a, icon: '\u2709\ufe0f' },
  role: { color: 0x8143e6, icon: '\ud83c\udfad' },
  post: { color: 0x26a269, icon: '\ud83d\udccc' },
  instance: { color: 0x1c9fd4, icon: '\ud83c\udf10' },
  group: { color: 0xdb7093, icon: '\ud83c\udfdb\ufe0f' },
  default: { color: 0x888888, icon: '\ud83d\udccb' },
}

// Known audit event types. Anything not listed is classified by the prefix
// heuristics below and routed to the default channel when unmatched.
const EVENTS = {
  'group.instance.warn': { category: 'warn', label: 'Member Warned' },
  'group.instance.kick': { category: 'kick', label: 'Kicked From Instance' },
  'group.member.kick': { category: 'kick', label: 'Member Kicked' },
  'group.member.ban': { category: 'ban', label: 'Member Banned' },
  'group.member.unban': { category: 'unban', label: 'Member Unbanned' },
  'group.member.join': { category: 'join', label: 'Member Joined' },
  'group.member.leave': { category: 'leave', label: 'Member Left' },
  'group.member.remove': { category: 'leave', label: 'Member Removed' },
  'group.member.role.assign': { category: 'role', label: 'Member Role Assigned' },
  'group.member.role.unassign': { category: 'role', label: 'Member Role Removed' },
  'group.role.create': { category: 'role', label: 'Role Created' },
  'group.role.update': { category: 'role', label: 'Role Updated' },
  'group.role.delete': { category: 'role', label: 'Role Deleted' },
  'group.request.create': { category: 'join_request', label: 'Join Request' },
  'group.request.deny': { category: 'join_request', label: 'Join Request Denied' },
  'group.request.reject': { category: 'join_request', label: 'Join Request Rejected' },
  'group.request.block': { category: 'join_request', label: 'Join Request Blocked' },
  'group.invite.create': { category: 'invite', label: 'Invite Sent' },
  'group.invite.delete': { category: 'invite', label: 'Invite Withdrawn' },
  'group.post.create': { category: 'post', label: 'Post Created' },
  'group.post.delete': { category: 'post', label: 'Post Deleted' },
  'group.announcement.create': { category: 'post', label: 'Announcement Created' },
  'group.announcement.delete': { category: 'post', label: 'Announcement Deleted' },
  'group.instance.create': { category: 'instance', label: 'Instance Opened' },
  'group.instance.close': { category: 'instance', label: 'Instance Closed' },
  'group.instance.delete': { category: 'instance', label: 'Instance Deleted' },
  'group.update': { category: 'group', label: 'Group Settings Updated' },
  'group.member.update': { category: 'default', label: 'Member Profile Updated' },
}

// VRChat has shipped alternate spellings for some entries (plurals, missing
// dots). Compare compacted forms so those still land on the right event.
const COMPACT_EVENTS = {}
for (const [type, meta] of Object.entries(EVENTS)) {
  COMPACT_EVENTS[type.replace(/[.\s]/g, '')] = { type, ...meta }
  COMPACT_EVENTS[type.replace(/[.\s]/g, '').replace('groupmember', 'groupmembers')] = { type, ...meta }
  COMPACT_EVENTS[type.replace(/[.\s]/g, '').replace('groupinstance', 'groupinstances')] = { type, ...meta }
}

function prettyLabel(eventType) {
  return String(eventType)
    .replace(/^group\./, '')
    .split('.')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ') || 'Group Event'
}

function classify(rawType) {
  const type = String(rawType || '').trim().toLowerCase()
  if (EVENTS[type]) return { eventType: type, ...EVENTS[type] }

  const compactHit = COMPACT_EVENTS[type.replace(/[.\s]/g, '')]
  if (compactHit) return { eventType: compactHit.type, category: compactHit.category, label: compactHit.label }

  // Prefix heuristics for events VRChat adds later.
  const cat = type.includes('.role') ? 'role'
    : type.includes('.request') ? 'join_request'
    : type.includes('.invite') ? 'invite'
    : type.includes('.post') || type.includes('.announcement') ? 'post'
    : type.includes('.instance') ? 'instance'
    : type.endsWith('.unban') ? 'unban'
    : type.endsWith('.ban') ? 'ban'
    : type.endsWith('.kick') ? 'kick'
    : type.endsWith('.warn') ? 'warn'
    : type.endsWith('.join') ? 'join'
    : type.endsWith('.leave') || type.endsWith('.remove') ? 'leave'
    : 'default'
  return { eventType: type, category: cat, label: prettyLabel(type) }
}

function channelFor(category) {
  const channels = config.groupLogs.channels
  return channels[category] || channels.default || ''
}

// ---------------------------------------------------------------
// embed building
// ---------------------------------------------------------------

function getTarget(entry) {
  const data = entry.data && typeof entry.data === 'object' ? entry.data : {}
  return {
    userId: entry.targetId || entry.targetUserId || data.targetId || data.targetUserId
      || data.userId || data.user?.id || '',
    username: entry.targetDisplayName || entry.targetName || data.targetDisplayName
      || data.targetName || data.displayName || data.user?.displayName || '',
  }
}

function userLine(userId, username) {
  const id = String(userId || '')
  const name = String(username || '') || id || 'unknown'
  if (!/^usr_/i.test(id)) return name
  let out = `[${name}](https://vrchat.com/home/user/${id})`
  const link = db.getLinkByVrchat(id)
  if (link) out += ` (linked: <@${link.discord_id}>)`
  return out
}

function formatDataPayload(data) {
  if (!data || typeof data !== 'object') return null
  const lines = []
  for (const [key, val] of Object.entries(data)) {
    if (val && typeof val === 'object' && ('old' in val || 'new' in val)) {
      lines.push(`**${key}**: \`${val.old ?? '(none)'}\` to \`${val.new ?? '(none)'}\``)
    } else if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
      lines.push(`**${key}**: ${String(val).slice(0, 180)}`)
    } else if (val !== null && val !== undefined) {
      try {
        lines.push(`**${key}**: \`${JSON.stringify(val).slice(0, 180)}\``)
      } catch { /* skip unserializable */ }
    }
  }
  return lines.length ? lines.join('\n').slice(0, 1024) : null
}

function buildEmbed(entry) {
  const { eventType, category, label } = classify(entry.eventType)
  const meta = CATEGORIES[category] || CATEGORIES.default
  const createdAt = entry.created_at ? new Date(entry.created_at) : new Date()
  const ms = createdAt.getTime()
  const unix = Math.floor((Number.isFinite(ms) ? ms : Date.now()) / 1000)
  const target = getTarget(entry)

  const fields = []
  if (entry.actorDisplayName || entry.actorId) {
    fields.push({ name: 'Actor', value: userLine(entry.actorId, entry.actorDisplayName).slice(0, 1024), inline: false })
  }
  // Skip the target when it is the actor acting on themselves (joins, leaves).
  if ((target.userId || target.username) && target.userId !== entry.actorId) {
    fields.push({ name: 'Target', value: userLine(target.userId, target.username).slice(0, 1024), inline: false })
  }
  const details = formatDataPayload(entry.data)
  if (details) fields.push({ name: 'Details', value: details, inline: false })
  fields.push({ name: 'When', value: `<t:${unix}:F> (<t:${unix}:R>)`, inline: false })

  return {
    category,
    embed: {
      title: `${meta.icon} ${label}`,
      color: meta.color,
      description: entry.description ? String(entry.description).slice(0, 2048) : undefined,
      fields: fields.slice(0, 25),
      footer: { text: `${eventType}${entry.id ? ` | ${entry.id}` : ''}` },
      timestamp: createdAt.toISOString(),
    },
  }
}

// ---------------------------------------------------------------
// polling
// ---------------------------------------------------------------

let clientRef = null
let pollTimer = null
let polling = false
let failStreak = 0
let lastAlertAt = 0

function anyChannelConfigured() {
  return Object.values(config.groupLogs.channels).some((id) => id)
}

async function sendToChannel(channelId, embed) {
  if (!clientRef || !channelId) return
  const channel = clientRef.channels.cache.get(channelId)
    || await clientRef.channels.fetch(channelId).catch(() => null)
  if (!channel || !channel.isTextBased?.()) {
    log.warn(`Group log channel ${channelId} is missing or not a text channel`)
    return
  }
  await channel.send({ embeds: [embed], allowedMentions: { parse: [] } })
}

async function poll() {
  if (polling) return
  polling = true
  try {
    const watermark = db.getKv(KV_WATERMARK, null)
    const seen = new Set(db.getKv(KV_SEEN, []))

    const opts = { n: 100 }
    if (watermark) {
      // Overlap the window by a second; seen ids absorb the duplicates.
      opts.startDate = new Date(new Date(watermark).getTime() - 1000).toISOString()
    }

    const data = await vrc.getGroupAuditLogs(opts)
    const results = Array.isArray(data?.results) ? data.results : []

    const sorted = results
      .filter((e) => e && e.id)
      .sort((a, b) => new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime())

    let posted = 0
    let newWatermark = watermark
    let dirty = false

    for (const entry of sorted) {
      if (seen.has(entry.id)) continue
      if (posted >= MAX_POSTS_PER_CYCLE) break

      const { category, embed } = buildEmbed(entry)
      const channelId = channelFor(category)
      if (channelId) {
        try {
          await sendToChannel(channelId, embed)
          posted += 1
        } catch (err) {
          log.warn(`Failed to post ${entry.eventType} to ${channelId}:`, err.message)
        }
      }

      seen.add(entry.id)
      dirty = true
      const ts = entry.created_at ? new Date(entry.created_at).getTime() : NaN
      if (Number.isFinite(ts) && (!newWatermark || ts > new Date(newWatermark).getTime())) {
        newWatermark = entry.created_at
      }
    }

    if (dirty || newWatermark !== watermark) {
      db.setKv(KV_SEEN, [...seen].slice(-SEEN_CAP))
      if (newWatermark) db.setKv(KV_WATERMARK, newWatermark)
    }

    if (posted) log.info(`Posted ${posted} group audit event${posted === 1 ? '' : 's'}`)
    failStreak = 0
  } catch (err) {
    failStreak += 1
    log.warn(`Audit log poll failed (${failStreak} in a row):`, err.message)
    if (failStreak >= 3 && Date.now() - lastAlertAt > ALERT_COOLDOWN_MS) {
      lastAlertAt = Date.now()
      discordLog.logAlert('Group audit log polling failing', `${failStreak} polls in a row failed. Latest error: ${err.message}`)
    }
  } finally {
    polling = false
  }
}

function start(client) {
  clientRef = client

  if (!anyChannelConfigured()) {
    log.info('No group log channels set in config.yml; audit log feed disabled.')
    return
  }

  // First run: start from now so we do not replay the group's history.
  if (!db.getKv(KV_WATERMARK, null)) {
    db.setKv(KV_WATERMARK, new Date().toISOString())
  }

  const intervalMs = config.groupLogs.pollSeconds * 1000
  log.info(`Group audit log feed on, polling every ${config.groupLogs.pollSeconds}s.`)
  poll()
  pollTimer = setInterval(poll, intervalMs)
  pollTimer.unref?.()
}

function stop() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

module.exports = { start, stop, _classify: classify, _buildEmbed: buildEmbed }
