'use strict'

// The sync engine: two way linked role sync, profile based misc roles, and
// stat tracker channels. Built to stay far under the VRChat API rate limit:
// every VRChat call is throttled globally (vrchatAuth), users are processed
// in small batches per cycle, and Discord channel renames respect Discord's
// own 2-per-10-minutes limit.

const { PermissionFlagsBits } = require('discord.js')
const config = require('./config')
const db = require('./db')
const logger = require('./logger')
const vrc = require('./vrchatApi')
const discordLog = require('./discordLog')

const log = logger('Sync')

// How many linked users get a full VRChat profile check per cycle. Two API
// calls per user (profile + group membership), so 10 users = 20 calls,
// comfortably inside the per-minute cap alongside trackers.
const USERS_PER_CYCLE = 10

// Discord allows roughly 2 channel renames per 10 minutes; stay safe.
const RENAME_MIN_INTERVAL_MS = 6 * 60 * 1000

// Trust rank role keys, exclusive with each other.
const RANK_KEYS = ['rank_trusted', 'rank_known', 'rank_user', 'rank_new_user', 'rank_visitor']
const RANK_KEY_BY_TRUST = {
  trusted: 'rank_trusted',
  known: 'rank_known',
  user: 'rank_user',
  new_user: 'rank_new_user',
  visitor: 'rank_visitor',
}

let running = false
let userCursor = 0

// ---------------------------------------------------------------
// VRChat hierarchy refusals
// ---------------------------------------------------------------

// VRChat only lets an account edit members BELOW its own highest group
// role, no matter what Discord permissions the bot has. When that (or a
// missing group permission) blocks an edit, pause VRChat role edits for
// that member instead of retrying every cycle, and alert once.
const HIERARCHY_BLOCK_MS = 6 * 60 * 60 * 1000
const hierarchyBlockedUntil = new Map()
const hierarchyAlerted = new Set()

function isHierarchyError(err) {
  return err?.status === 403 || /same or higher rank|not allowed/i.test(String(err?.message || ''))
}

function isHierarchyBlocked(vrchatId) {
  const until = hierarchyBlockedUntil.get(vrchatId)
  if (!until) return false
  if (Date.now() > until) {
    hierarchyBlockedUntil.delete(vrchatId)
    return false
  }
  return true
}

function noteHierarchyBlock(link, roleName, err) {
  hierarchyBlockedUntil.set(link.vrchat_id, Date.now() + HIERARCHY_BLOCK_MS)
  const who = link.vrchat_name || link.vrchat_id
  log.warn(`VRChat refuses role edits for ${who} (group hierarchy or permissions): ${err.vrchatMessage || err.message}`)
  if (hierarchyAlerted.has(link.vrchat_id)) return
  hierarchyAlerted.add(link.vrchat_id)
  discordLog.logAlert(
    'VRChat blocks role sync for a member',
    [
      `I cannot edit the VRChat group roles of **${who}** (tried **${roleName}**).`,
      `VRChat said: ${err.vrchatMessage || err.message}`,
      '',
      'VRChat only lets an account edit members **below** its own highest group role; Discord admin does not matter here. Fix it in the VRChat group settings:',
      '1. Move the bot account\'s group role above the roles of every member it should manage, and',
      '2. Make sure that role has the **Manage Group Member Data** permission.',
      '',
      'I paused VRChat role edits for this member for 6 hours so the logs stay clean.',
    ].join('\n')
  )
}

// ---------------------------------------------------------------
// cached group roles (for autocomplete and name lookups)
// ---------------------------------------------------------------

let cachedRoles = null
let cachedRolesAt = 0
const ROLES_CACHE_TTL = 5 * 60 * 1000

async function getCachedGroupRoles({ force = false } = {}) {
  if (!force && cachedRoles && Date.now() - cachedRolesAt < ROLES_CACHE_TTL) return cachedRoles
  cachedRoles = await vrc.getGroupRoles()
  cachedRolesAt = Date.now()
  return cachedRoles
}

async function vrchatHealthy() {
  try {
    const { getAuthCookies } = require('./vrchatAuth')
    return Boolean(await getAuthCookies())
  } catch {
    return false
  }
}

// ---------------------------------------------------------------
// stats for tracker channels
// ---------------------------------------------------------------

async function readStat(stat) {
  if (stat === 'group_members') {
    const group = await vrc.getGroup()
    return Number(group?.memberCount ?? 0)
  }
  if (stat === 'open_instances') {
    const instances = await vrc.getGroupInstances()
    return instances.length
  }
  if (stat === 'users_in_instances') {
    const instances = await vrc.getGroupInstances()
    return instances.reduce((sum, inst) => sum + Number(inst?.memberCount ?? inst?.nUsers ?? 0), 0)
  }
  throw new Error(`Unknown stat: ${stat}`)
}

async function updateTrackers(guild) {
  const trackers = db.listTrackers()
  if (!trackers.length) return

  // One API read per stat type per cycle, shared across channels.
  const values = {}
  for (const stat of new Set(trackers.map((t) => t.stat))) {
    try {
      values[stat] = String(await readStat(stat))
    } catch (err) {
      log.warn(`stat read failed (${stat}):`, err.message)
    }
  }

  for (const tracker of trackers) {
    const value = values[tracker.stat]
    if (value == null) continue

    const channel = guild.channels.cache.get(tracker.channel_id)
      || await guild.channels.fetch(tracker.channel_id).catch(() => null)
    if (!channel) {
      log.info(`Tracker channel ${tracker.channel_id} is gone; removing tracker`)
      db.removeTracker(tracker.channel_id)
      continue
    }

    if (value === tracker.last_value) continue
    if (Date.now() - tracker.last_renamed_at < RENAME_MIN_INTERVAL_MS) continue

    const newName = `${tracker.label}: ${value}`
    try {
      await channel.setName(newName, 'Stat tracker update')
      db.updateTracker(tracker.channel_id, value, Date.now())
      log.info(`Tracker renamed: ${newName}`)
    } catch (err) {
      log.warn(`tracker rename failed (${tracker.channel_id}):`, err.message)
    }
  }
}

// ---------------------------------------------------------------
// misc roles (18+, VRC+, trust ranks, repping, group tenure)
// ---------------------------------------------------------------

// Tenure roles, longest first: a member only keeps the highest one earned.
const TENURE_TIERS = [
  { key: 'tenure_1y', days: 365 },
  { key: 'tenure_6m', days: 182 },
  { key: 'tenure_1m', days: 30 },
]
const TENURE_KEYS = TENURE_TIERS.map((t) => t.key)

function tenureKeyFor(joinedAt) {
  const ms = Date.parse(joinedAt || '')
  if (!Number.isFinite(ms)) return null
  const days = (Date.now() - ms) / 86_400_000
  return TENURE_TIERS.find((t) => days >= t.days)?.key || null
}

async function applyMiscRoles(member, vrchatUser, groupMember = null) {
  const miscRoles = db.getMiscRoles()
  if (!Object.keys(miscRoles).length) return

  const rank = vrc.getTrustRank(vrchatUser)
  const wantedRankKey = RANK_KEY_BY_TRUST[rank.key] || 'rank_visitor'

  const wants = {
    age_18: vrc.isAgeVerified18Plus(vrchatUser),
    vrc_plus: vrc.hasVrcPlus(vrchatUser),
  }
  for (const key of RANK_KEYS) wants[key] = key === wantedRankKey

  // Group member extras. Only touched when we actually have the member
  // object, so a failed fetch never strips someone's roles.
  if (groupMember) {
    wants.repping = Boolean(groupMember.isRepresenting)
    const tenureKey = tenureKeyFor(groupMember.joinedAt)
    for (const key of TENURE_KEYS) wants[key] = key === tenureKey
  }

  for (const [key, roleId] of Object.entries(miscRoles)) {
    if (!(key in wants)) continue
    const has = member.roles.cache.has(roleId)
    const want = Boolean(wants[key])
    if (want === has) continue
    try {
      if (want) await member.roles.add(roleId, 'VRChat profile sync')
      else await member.roles.remove(roleId, 'VRChat profile sync')
      log.info(`${want ? 'Added' : 'Removed'} misc role ${key} ${want ? 'to' : 'from'} ${member.user.tag}`)
      discordLog.logRoleChange({
        discordId: member.id,
        action: want ? 'added' : 'removed',
        side: 'Discord',
        roleName: `<@&${roleId}> (${key})`,
        drivenBy: 'VRChat profile (misc role)',
      })
    } catch (err) {
      log.warn(`misc role ${key} update failed for ${member.user.tag}:`, err.message)
      noteMiscRolePermissionProblem(key, roleId, err)
    }
  }
}

// Discord refuses role edits when the bot's highest role is not above the
// role being assigned (or Manage Roles is missing). Alert once per role.
const miscRoleAlerted = new Set()
function noteMiscRolePermissionProblem(key, roleId, err) {
  const msg = String(err?.message || '')
  if (!/missing permissions|missing access|hierarchy/i.test(msg)) return
  if (miscRoleAlerted.has(key)) return
  miscRoleAlerted.add(key)
  discordLog.logAlert(
    'Discord blocks a misc role',
    [
      `I cannot assign <@&${roleId}> (**${key}**): ${msg}`,
      '',
      'Fix in Discord server settings, Roles: drag the bot\'s role **above** the 18+, VRC+, and trust rank roles, and make sure the bot has **Manage Roles**.',
    ].join('\n')
  )
}

// ---------------------------------------------------------------
// misc role health
//
// The single most common reason profile roles never appear is that
// /setup-misc-roles was never run, or the bot's own role sits below the
// roles it is meant to hand out. Check both on startup and every hour and
// say so loudly instead of failing quietly.
// ---------------------------------------------------------------

const MISC_HEALTH_INTERVAL_MS = 60 * 60 * 1000
let lastMiscHealthAt = 0
let miscHealthAlerted = ''

async function miscRoleHealth(client) {
  const miscRoles = db.getMiscRoles()
  const problems = []

  if (!Object.keys(miscRoles).length) {
    problems.push('No profile roles exist yet. Run **/setup-misc-roles** once and they start applying on the next pass.')
  }

  let guild = null
  try {
    guild = await client.guilds.fetch(config.discord.guildId)
  } catch {
    return problems
  }

  const me = guild.members.me || await guild.members.fetchMe().catch(() => null)
  if (me) {
    if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
      problems.push('I am missing the **Manage Roles** permission, so I cannot hand out any role.')
    }
    const myTop = me.roles.highest?.position ?? 0
    const blocked = []
    for (const [key, roleId] of Object.entries(miscRoles)) {
      const role = guild.roles.cache.get(roleId) || await guild.roles.fetch(roleId).catch(() => null)
      if (!role) {
        blocked.push(`${key} (role was deleted, re-run /setup-misc-roles)`)
      } else if (role.position >= myTop) {
        blocked.push(`${role.name} (sits above me)`)
      }
    }
    if (blocked.length) {
      problems.push(`Discord will not let me assign: ${blocked.join(', ')}. Drag my role **above** them in Server Settings, Roles.`)
    }
  }

  const signature = problems.join(' | ')
  if (problems.length) {
    log.warn(`Profile role check: ${signature}`)
    if (signature !== miscHealthAlerted) {
      miscHealthAlerted = signature
      discordLog.logAlert('Profile roles are not being applied', problems.join('\n\n'))
    }
  } else {
    if (miscHealthAlerted) log.info('Profile role problems cleared.')
    miscHealthAlerted = ''
    log.debug(`Profile roles healthy (${Object.keys(miscRoles).length} roles).`)
  }
  return problems
}

async function removeMiscRoles(client, discordId) {  const guild = await client.guilds.fetch(config.discord.guildId)
  const member = await guild.members.fetch(discordId).catch(() => null)
  if (!member) return
  const miscRoles = db.getMiscRoles()
  for (const roleId of Object.values(miscRoles)) {
    if (member.roles.cache.has(roleId)) {
      await member.roles.remove(roleId, 'VRChat account unlinked').catch(() => {})
    }
  }
}

// ---------------------------------------------------------------
// two way linked role sync
//
// For every (linked user, linked role pair) we remember the last state of
// both sides. On each pass we compare current state to the stored state:
//   - only Discord changed  -> mirror the change to VRChat
//   - only VRChat changed   -> mirror the change to Discord
//   - both changed the same way -> nothing to mirror
//   - both changed against each other -> Discord wins (deterministic)
// First time we see a user, holding the role on either side grants the
// other side (union), which matches "when they get the role, give it".
// ---------------------------------------------------------------

async function syncLinkedRolesForMember(member, groupMember) {
  const pairs = db.listLinkedRoles()
  if (!pairs.length) return

  const inGroup = Boolean(groupMember)
  const vrchatRoleIds = new Set(groupMember?.roleIds || [])
  const link = db.getLinkByDiscord(member.id)
  if (!link) return

  for (const pair of pairs) {
    const hasDiscord = member.roles.cache.has(pair.discord_role_id)
    const hasVrchat = vrchatRoleIds.has(pair.vrchat_role_id)
    const stored = db.getRoleState(member.id, pair.discord_role_id)

    let targetDiscord = hasDiscord
    let targetVrchat = hasVrchat

    if (!stored) {
      // First sight: union grants.
      targetDiscord = hasDiscord || hasVrchat
      targetVrchat = hasDiscord || hasVrchat
    } else {
      const discordChanged = hasDiscord !== Boolean(stored.had_discord)
      const vrchatChanged = hasVrchat !== Boolean(stored.had_vrchat)
      if (discordChanged && !vrchatChanged) {
        targetVrchat = hasDiscord
      } else if (vrchatChanged && !discordChanged) {
        targetDiscord = hasVrchat
      } else if (discordChanged && vrchatChanged && hasDiscord !== hasVrchat) {
        // Conflict in opposite directions inside one cycle: Discord wins.
        targetVrchat = hasDiscord
        targetDiscord = hasDiscord
      }
    }

    // Apply Discord side
    if (targetDiscord !== hasDiscord) {
      try {
        if (targetDiscord) await member.roles.add(pair.discord_role_id, 'VRChat group role sync')
        else await member.roles.remove(pair.discord_role_id, 'VRChat group role sync')
        log.info(`${targetDiscord ? 'Added' : 'Removed'} @${pair.discord_role_name} ${targetDiscord ? 'to' : 'from'} ${member.user.tag} (VRChat side drove it)`)
        discordLog.logRoleChange({
          discordId: member.id,
          action: targetDiscord ? 'added' : 'removed',
          side: 'Discord',
          roleName: `@${pair.discord_role_name}`,
          drivenBy: 'VRChat group change',
        })
      } catch (err) {
        log.warn(`discord role update failed for ${member.user.tag}:`, err.message)
        targetDiscord = hasDiscord
      }
    }

    // Apply VRChat side (only possible when they are in the group)
    if (targetVrchat !== hasVrchat) {
      if (!inGroup || isHierarchyBlocked(link.vrchat_id)) {
        targetVrchat = hasVrchat
      } else {
        try {
          if (targetVrchat) await vrc.addGroupMemberRole(link.vrchat_id, pair.vrchat_role_id)
          else await vrc.removeGroupMemberRole(link.vrchat_id, pair.vrchat_role_id)
          log.info(`${targetVrchat ? 'Added' : 'Removed'} VRChat role ${pair.vrchat_role_name} ${targetVrchat ? 'to' : 'from'} ${link.vrchat_name || link.vrchat_id} (Discord side drove it)`)
          discordLog.logRoleChange({
            discordId: member.id,
            action: targetVrchat ? 'added' : 'removed',
            side: 'VRChat',
            roleName: pair.vrchat_role_name,
            drivenBy: 'Discord role change',
          })
        } catch (err) {
          if (isHierarchyError(err)) noteHierarchyBlock(link, pair.vrchat_role_name, err)
          else log.warn(`vrchat role update failed for ${link.vrchat_id}:`, err.message)
          targetVrchat = hasVrchat
        }
      }
    }

    db.setRoleState(member.id, pair.discord_role_id, targetDiscord, targetVrchat)
  }
}

// ---------------------------------------------------------------
// per-user full sync (profile + membership + roles)
// ---------------------------------------------------------------

async function syncOneUser(client, discordId) {
  const link = db.getLinkByDiscord(discordId)
  if (!link) return

  const guild = await client.guilds.fetch(config.discord.guildId)
  const member = await guild.members.fetch(discordId).catch(() => null)
  if (!member) return

  let vrchatUser = null
  try {
    vrchatUser = await vrc.getUser(link.vrchat_id)
  } catch (err) {
    log.warn(`profile fetch failed for ${link.vrchat_id}:`, err.message)
  }
  if (!vrchatUser) return

  // Keep the stored display name fresh.
  if (vrchatUser.displayName && vrchatUser.displayName !== link.vrchat_name) {
    db.createLink(discordId, link.vrchat_id, vrchatUser.displayName)
  }

  let groupMember = null
  try {
    groupMember = await vrc.getGroupMember(link.vrchat_id)
  } catch (err) {
    log.warn(`group member fetch failed for ${link.vrchat_id}:`, err.message)
  }

  await applyMiscRoles(member, vrchatUser, groupMember)
  await syncLinkedRolesForMember(member, groupMember)
}

// ---------------------------------------------------------------
// fast path: Discord role changes push to VRChat immediately
// ---------------------------------------------------------------

async function onMemberUpdate(oldMember, newMember) {
  if (config.simpleMode) return
  const link = db.getLinkByDiscord(newMember.id)
  if (!link) return
  if (isHierarchyBlocked(link.vrchat_id)) return
  const pairs = db.listLinkedRoles()
  if (!pairs.length) return

  const changed = pairs.filter((p) =>
    oldMember.roles.cache.has(p.discord_role_id) !== newMember.roles.cache.has(p.discord_role_id)
  )
  if (!changed.length) return

  let groupMember = null
  try {
    groupMember = await vrc.getGroupMember(link.vrchat_id)
  } catch (err) {
    log.warn('fast path group fetch failed:', err.message)
    return
  }
  if (!groupMember) return
  const vrchatRoleIds = new Set(groupMember.roleIds || [])

  for (const pair of changed) {
    const nowHas = newMember.roles.cache.has(pair.discord_role_id)
    const vrchatHas = vrchatRoleIds.has(pair.vrchat_role_id)
    if (nowHas !== vrchatHas) {
      try {
        if (nowHas) await vrc.addGroupMemberRole(link.vrchat_id, pair.vrchat_role_id)
        else await vrc.removeGroupMemberRole(link.vrchat_id, pair.vrchat_role_id)
        log.info(`Fast sync: ${nowHas ? 'added' : 'removed'} VRChat role ${pair.vrchat_role_name} for ${link.vrchat_name || link.vrchat_id}`)
        discordLog.logRoleChange({
          discordId: newMember.id,
          action: nowHas ? 'added' : 'removed',
          side: 'VRChat',
          roleName: pair.vrchat_role_name,
          drivenBy: 'Discord role change (instant)',
        })
      } catch (err) {
        if (isHierarchyError(err)) noteHierarchyBlock(link, pair.vrchat_role_name, err)
        else log.warn('fast sync failed:', err.message)
        continue
      }
    }
    db.setRoleState(newMember.id, pair.discord_role_id, nowHas, nowHas)
  }
}

// ---------------------------------------------------------------
// the loop
// ---------------------------------------------------------------

async function runCycle(client) {
  if (running) {
    log.debug('Previous cycle still running; skipping this tick')
    return
  }
  running = true
  const startedAt = Date.now()
  try {
    db.purgeExpiredCodes()

    const guild = await client.guilds.fetch(config.discord.guildId)

    await updateTrackers(guild)

    // Simple mode keeps the tracker channels but does no linking or role
    // work at all.
    if (config.simpleMode) {
      log.debug(`Cycle done in ${Date.now() - startedAt}ms (simple mode: trackers only)`)
      return
    }

    if (Date.now() - lastMiscHealthAt > MISC_HEALTH_INTERVAL_MS) {
      lastMiscHealthAt = Date.now()
      await miscRoleHealth(client).catch((err) => log.warn('profile role check failed:', err.message))
    }

    // Round robin through linked users so big communities still cover
    // everyone without ever bursting the API.
    const links = db.listLinks()
    if (links.length) {
      const batch = []
      for (let i = 0; i < Math.min(USERS_PER_CYCLE, links.length); i++) {
        batch.push(links[(userCursor + i) % links.length])
      }
      userCursor = (userCursor + batch.length) % links.length

      for (const link of batch) {
        try {
          await syncOneUser(client, link.discord_id)
        } catch (err) {
          log.warn(`user sync failed (${link.discord_id}):`, err.message)
        }
      }
    }

    log.debug(`Cycle done in ${Date.now() - startedAt}ms (${links.length} links total)`)
  } catch (err) {
    log.error('Sync cycle failed:', err.message)
    discordLog.logAlert('Sync cycle failed', err.message)
  } finally {
    running = false
  }
}

function startLoop(client) {
  const intervalMs = config.sync.intervalSeconds * 1000
  if (config.simpleMode) {
    log.info('Simple mode is on: logs only, no account linking or role sync.')
  }
  const linkCount = db.listLinks().length
  if (config.simpleMode) {
    // nothing to report about roles
  } else if (!Object.keys(db.getMiscRoles()).length) {
    log.info('Misc roles are not set up yet; run /setup-misc-roles to enable 18+, VRC+, trust rank, repping, and tenure roles.')
  } else if (linkCount) {
    const minutes = Math.ceil((linkCount / USERS_PER_CYCLE) * config.sync.intervalSeconds / 60)
    log.info(`Profile roles rechecked for all ${linkCount} linked member${linkCount === 1 ? '' : 's'} about every ${minutes} minute${minutes === 1 ? '' : 's'}.`)
  }
  setTimeout(() => runCycle(client), 10_000)
  const timer = setInterval(() => runCycle(client), intervalMs)
  timer.unref?.()
  log.info(`Auto sync every ${config.sync.intervalSeconds}s (${USERS_PER_CYCLE} users per cycle, trackers rename at most every ${RENAME_MIN_INTERVAL_MS / 60000} min)`)
}

module.exports = {
  startLoop,
  runCycle,
  syncOneUser,
  onMemberUpdate,
  applyMiscRoles,
  removeMiscRoles,
  miscRoleHealth,
  getCachedGroupRoles,
  readStat,
  vrchatHealthy,
}
