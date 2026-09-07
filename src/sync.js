'use strict'

// Two way linked role sync, profile based misc roles, and stat tracker channels, driven off a cached roster so a full pass is free.

const { PermissionFlagsBits } = require('discord.js')
const config = require('./config')
const db = require('./db')
const logger = require('./logger')
const vrc = require('./vrchatApi')
const roster = require('./roster')
const discordLog = require('./discordLog')

const log = logger('Sync')

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

// Tenure roles, longest first: a member only keeps the highest one earned.
const TENURE_TIERS = [
  { key: 'tenure_1y', days: 365 },
  { key: 'tenure_6m', days: 182 },
  { key: 'tenure_1m', days: 30 },
]
const TENURE_KEYS = TENURE_TIERS.map((t) => t.key)

let running = false
let clientRef = null
const stats = {
  cycles: 0,
  lastCycleAt: 0,
  lastCycleMs: 0,
  lastChecked: 0,
  lastChanged: 0,
  lastProfiles: 0,
  eventsHandled: 0,
  lastError: '',
}

// ---------------------------------------------------------------
// per member serialisation
// ---------------------------------------------------------------

// The cycle, the gateway fast path, and the admin commands can all hit one member at once, and interleaving would clobber role state.
const chains = new Map()

function withMemberLock(discordId, task) {
  const key = String(discordId)
  const previous = chains.get(key) || Promise.resolve()
  const result = previous.then(task, task)
  const settled = result.catch(() => {})
  chains.set(key, settled)
  settled.then(() => {
    if (chains.get(key) === settled) chains.delete(key)
  })
  return result
}

// ---------------------------------------------------------------
// echo suppression
// ---------------------------------------------------------------

// Every role edit the bot makes comes back as a GuildMemberUpdate; without this the fast path re-examines its own work and can flap.
const SELF_EDIT_TTL_MS = 30_000
const selfEdits = new Map()

function markSelfEdit(discordId, roleIds) {
  const until = Date.now() + SELF_EDIT_TTL_MS
  for (const roleId of roleIds) selfEdits.set(`${discordId}:${roleId}`, until)
}

function wasSelfEdit(discordId, roleId) {
  const key = `${discordId}:${roleId}`
  const until = selfEdits.get(key)
  if (!until) return false
  selfEdits.delete(key)
  return until > Date.now()
}

function pruneSelfEdits() {
  const now = Date.now()
  for (const [key, until] of selfEdits) {
    if (until < now) selfEdits.delete(key)
  }
}

// ---------------------------------------------------------------
// VRChat hierarchy refusals
// ---------------------------------------------------------------

// VRChat only lets an account edit members below its own highest group role, so pause edits for a refused member and alert once.
const HIERARCHY_BLOCK_MS = 6 * 60 * 60 * 1000
const KV_HIERARCHY = 'hierarchy_blocks'

function loadHierarchyBlocks() {
  const raw = db.getKv(KV_HIERARCHY, {})
  return raw && typeof raw === 'object' ? raw : {}
}

function isHierarchyError(err) {
  return err?.status === 403 || /same or higher rank|not allowed/i.test(String(err?.message || ''))
}

function isHierarchyBlocked(vrchatId) {
  const blocks = loadHierarchyBlocks()
  const until = blocks[vrchatId]
  if (!until) return false
  if (Date.now() > until) {
    delete blocks[vrchatId]
    db.setKv(KV_HIERARCHY, blocks)
    return false
  }
  return true
}

function hierarchyBlockCount() {
  const now = Date.now()
  return Object.values(loadHierarchyBlocks()).filter((until) => until > now).length
}

function noteHierarchyBlock(link, roleName, err) {
  const blocks = loadHierarchyBlocks()
  const alreadyBlocked = Number(blocks[link.vrchat_id] || 0) > Date.now()
  blocks[link.vrchat_id] = Date.now() + HIERARCHY_BLOCK_MS
  db.setKv(KV_HIERARCHY, blocks)

  const who = link.vrchat_name || link.vrchat_id
  log.warn(`VRChat refuses role edits for ${who} (group hierarchy or permissions): ${err.vrchatMessage || err.message}`)
  if (alreadyBlocked) return
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
  if (stat === 'linked_members') return db.countLinks()
  throw new Error(`Unknown stat: ${stat}`)
}

async function updateTrackers(guild) {
  const trackers = db.listTrackers()
  if (!trackers.length) return

  // A tracker inside its rename cooldown cannot use a fresh number, and every read is an API call.
  const due = trackers.filter((t) => Date.now() - t.last_renamed_at >= RENAME_MIN_INTERVAL_MS)
  if (!due.length) return

  const values = {}
  for (const stat of new Set(due.map((t) => t.stat))) {
    try {
      values[stat] = String(await readStat(stat))
    } catch (err) {
      log.warn(`stat read failed (${stat}):`, err.message)
    }
  }

  for (const tracker of due) {
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
// profile facts (18+, VRC+, trust rank) and misc roles
// ---------------------------------------------------------------

function tenureKeyFor(joinedAt) {
  const ms = Date.parse(joinedAt || '')
  if (!Number.isFinite(ms)) return null
  const days = (Date.now() - ms) / 86_400_000
  return TENURE_TIERS.find((t) => days >= t.days)?.key || null
}

/** Pull a profile from VRChat and cache the few facts the roles need. */
async function refreshProfileFacts(link) {
  const user = await vrc.getUser(link.vrchat_id)
  if (!user) return null
  const facts = {
    vrchatId: link.vrchat_id,
    displayName: user.displayName || link.vrchat_name || '',
    trustKey: vrc.getTrustRank(user).key,
    vrcPlus: vrc.hasVrcPlus(user),
    age18: vrc.isAgeVerified18Plus(user),
    fetchedAt: Date.now(),
  }
  db.setProfileFacts(link.vrchat_id, facts)
  if (facts.displayName && facts.displayName !== link.vrchat_name) {
    db.createLink(link.discord_id, link.vrchat_id, facts.displayName)
  }
  return facts
}

/** Roles a member should hold. Keys with no evidence behind them are left out, so a missing profile never strips anything. */
function desiredMiscRoles(facts, groupMember, { groupKnown = false } = {}) {
  const wants = {}
  if (facts) {
    wants.age_18 = facts.age18
    wants.vrc_plus = facts.vrcPlus
    const rankKey = RANK_KEY_BY_TRUST[facts.trustKey] || 'rank_visitor'
    for (const key of RANK_KEYS) wants[key] = key === rankKey
  }
  if (groupMember) {
    wants.repping = Boolean(groupMember.isRepresenting)
    const tenureKey = tenureKeyFor(groupMember.joinedAt)
    for (const key of TENURE_KEYS) wants[key] = key === tenureKey
  } else if (groupKnown) {
    wants.repping = false
    for (const key of TENURE_KEYS) wants[key] = false
  }
  return wants
}

// Discord refuses role edits when the bot's highest role is not above the target role, or Manage Roles is missing.
const roleAlerted = new Set()
function noteRolePermissionProblem(label, roleId, err) {
  const msg = String(err?.message || '')
  if (!/missing permissions|missing access|hierarchy/i.test(msg)) return
  if (roleAlerted.has(roleId)) return
  roleAlerted.add(roleId)
  discordLog.logAlert(
    'Discord blocks a role',
    [
      `I cannot assign <@&${roleId}> (**${label}**): ${msg}`,
      '',
      'Fix in Discord server settings, Roles: drag the bot\'s role **above** every role it hands out, and make sure the bot has **Manage Roles**.',
    ].join('\n')
  )
}

/** Apply a batch of role changes in one write, built from the roles the member already holds so only managed roles move. */
async function applyDiscordRoles(member, changes) {
  if (!changes.length) return { applied: [], failed: [] }

  markSelfEdit(member.id, changes.map((c) => c.roleId))

  if (changes.length === 1) {
    const change = changes[0]
    try {
      if (change.add) await member.roles.add(change.roleId, change.reason)
      else await member.roles.remove(change.roleId, change.reason)
      return { applied: changes, failed: [] }
    } catch (err) {
      log.warn(`role update failed for ${member.user.tag}:`, err.message)
      noteRolePermissionProblem(change.label, change.roleId, err)
      return { applied: [], failed: changes }
    }
  }

  const target = new Set(
    member.roles.cache.filter((r) => r.id !== member.guild.id).map((r) => r.id)
  )
  for (const change of changes) {
    if (change.add) target.add(change.roleId)
    else target.delete(change.roleId)
  }

  try {
    await member.roles.set([...target], changes[0].reason)
    return { applied: changes, failed: [] }
  } catch (err) {
    log.warn(`batched role update failed for ${member.user.tag}:`, err.message)
    for (const change of changes) noteRolePermissionProblem(change.label, change.roleId, err)
    return { applied: [], failed: changes }
  }
}

// ---------------------------------------------------------------
// misc role health
// ---------------------------------------------------------------

// Roles usually fail to appear because /setup-misc-roles was never run or the bot's role sits below the ones it hands out.
const MISC_HEALTH_INTERVAL_MS = 60 * 60 * 1000
let lastMiscHealthAt = 0
let miscHealthAlerted = ''

// The roster is what makes a whole-group pass affordable, so losing it is a real degradation worth saying out loud once.
let rosterAlerted = false
function noteRosterUnusable() {
  const state = roster.status()
  log.warn(`Group member list unavailable (${state.lastError || 'never loaded'}); syncing a few members per cycle instead of all of them.`)
  if (rosterAlerted) return
  rosterAlerted = true
  discordLog.logAlert(
    'I cannot read the group member list',
    [
      `Reading the whole member list is what lets me check every linked member every cycle. It is failing: ${state.lastError || 'it has never loaded'}.`,
      '',
      'The bot\'s VRChat account needs a group role with permission to **view all members**. Until then I fall back to checking a few members per cycle, so role changes take much longer to land.',
    ].join('\n')
  )
}

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
    const managed = [
      ...Object.entries(miscRoles),
      ...db.listLinkedRoles().map((p) => [p.discord_role_name || 'linked role', p.discord_role_id]),
    ]
    for (const [key, roleId] of managed) {
      const role = guild.roles.cache.get(roleId) || await guild.roles.fetch(roleId).catch(() => null)
      if (!role) {
        blocked.push(`${key} (role was deleted)`)
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
    log.warn(`Role health check: ${signature}`)
    if (signature !== miscHealthAlerted) {
      miscHealthAlerted = signature
      discordLog.logAlert('Roles are not being applied', problems.join('\n\n'))
    }
  } else {
    if (miscHealthAlerted) log.info('Role problems cleared.')
    miscHealthAlerted = ''
    log.debug(`Roles healthy (${Object.keys(miscRoles).length} profile roles).`)
  }
  return problems
}

async function removeMiscRoles(client, discordId) {
  const guild = await client.guilds.fetch(config.discord.guildId)
  const member = await guild.members.fetch(discordId).catch(() => null)
  if (!member) return
  const held = Object.values(db.getMiscRoles()).filter((roleId) => member.roles.cache.has(roleId))
  if (!held.length) return
  markSelfEdit(member.id, held)
  const target = member.roles.cache
    .filter((r) => r.id !== guild.id && !held.includes(r.id))
    .map((r) => r.id)
  await member.roles.set(target, 'VRChat account unlinked').catch(() => {})
}

// ---------------------------------------------------------------
// two way linked role sync
// ---------------------------------------------------------------

// Whichever side moved away from the stored state gets mirrored to the other; a genuine conflict goes to sync.conflict_winner.
function planLinkedRoles(member, groupMember, { firstSight = false } = {}) {
  const plan = []
  const vrchatRoleIds = new Set(groupMember?.roleIds || [])
  const inGroup = Boolean(groupMember)

  for (const pair of db.listLinkedRoles()) {
    const hasDiscord = member.roles.cache.has(pair.discord_role_id)
    const hasVrchat = vrchatRoleIds.has(pair.vrchat_role_id)
    const stored = firstSight ? null : db.getRoleState(member.id, pair.discord_role_id)

    let targetDiscord = hasDiscord
    let targetVrchat = hasVrchat

    if (!stored) {
      if (config.sync.grantOnFirstSight) {
        targetDiscord = hasDiscord || hasVrchat
        targetVrchat = hasDiscord || hasVrchat
      }
    } else {
      const discordChanged = hasDiscord !== Boolean(stored.had_discord)
      const vrchatChanged = hasVrchat !== Boolean(stored.had_vrchat)
      if (discordChanged && !vrchatChanged) {
        targetVrchat = hasDiscord
      } else if (vrchatChanged && !discordChanged) {
        targetDiscord = hasVrchat
      } else if (discordChanged && vrchatChanged && hasDiscord !== hasVrchat) {
        const winner = config.sync.conflictWinner === 'vrchat' ? hasVrchat : hasDiscord
        targetDiscord = winner
        targetVrchat = winner
      }
    }

    // Nobody holds a group role while outside the group.
    if (!inGroup) targetVrchat = false

    plan.push({ pair, hasDiscord, hasVrchat, targetDiscord, targetVrchat, inGroup })
  }

  return plan
}

// ---------------------------------------------------------------
// one member, one pass
// ---------------------------------------------------------------

/** Reconcile one member from data already in hand: one Discord write, plus one VRChat call per linked pair that moved. */
async function reconcile(member, link, { facts, groupMember, groupKnown }) {
  const miscRoles = db.getMiscRoles()
  const changes = []

  const wants = desiredMiscRoles(facts, groupMember, { groupKnown })
  for (const [key, roleId] of Object.entries(miscRoles)) {
    if (!(key in wants)) continue
    const has = member.roles.cache.has(roleId)
    const want = Boolean(wants[key])
    if (want === has) continue
    changes.push({ roleId, add: want, label: key, kind: 'misc', reason: 'VRChat profile sync' })
  }

  // Unknown membership reads as every VRChat role missing, and joining is not a change against stored state, so a join re-runs the union.
  const wasInGroup = db.getKv(`in_group:${member.id}`, null)
  const joinUnion = Boolean(groupMember) && wasInGroup !== true
  const linkedPlan = groupKnown ? planLinkedRoles(member, groupMember, { firstSight: joinUnion }) : []
  for (const step of linkedPlan) {
    if (step.targetDiscord === step.hasDiscord) continue
    changes.push({
      roleId: step.pair.discord_role_id,
      add: step.targetDiscord,
      label: step.pair.discord_role_name,
      kind: 'linked',
      reason: 'VRChat group role sync',
    })
  }

  const { applied, failed } = await applyDiscordRoles(member, changes)
  const failedIds = new Set(failed.map((c) => c.roleId))

  for (const change of applied) {
    log.info(`${change.add ? 'Added' : 'Removed'} ${change.label} ${change.add ? 'to' : 'from'} ${member.user.tag}`)
    discordLog.logRoleChange({
      discordId: member.id,
      action: change.add ? 'added' : 'removed',
      side: 'Discord',
      roleName: change.kind === 'misc' ? `<@&${change.roleId}> (${change.label})` : `@${change.label}`,
      drivenBy: change.kind === 'misc' ? 'VRChat profile (misc role)' : 'VRChat group change',
    })
  }

  for (const step of linkedPlan) {
    const { pair } = step
    const finalDiscord = failedIds.has(pair.discord_role_id) ? step.hasDiscord : step.targetDiscord
    let finalVrchat = step.hasVrchat

    if (step.targetVrchat !== step.hasVrchat && step.inGroup && !isHierarchyBlocked(link.vrchat_id)) {
      try {
        if (step.targetVrchat) await vrc.addGroupMemberRole(link.vrchat_id, pair.vrchat_role_id)
        else await vrc.removeGroupMemberRole(link.vrchat_id, pair.vrchat_role_id)
        finalVrchat = step.targetVrchat
        log.info(`${finalVrchat ? 'Added' : 'Removed'} VRChat role ${pair.vrchat_role_name} ${finalVrchat ? 'to' : 'from'} ${link.vrchat_name || link.vrchat_id}`)
        discordLog.logRoleChange({
          discordId: member.id,
          action: finalVrchat ? 'added' : 'removed',
          side: 'VRChat',
          roleName: pair.vrchat_role_name,
          drivenBy: 'Discord role change',
        })
        // Keep the roster honest so the next pass does not undo this.
        if (groupMember) {
          const ids = new Set(groupMember.roleIds || [])
          if (finalVrchat) ids.add(pair.vrchat_role_id)
          else ids.delete(pair.vrchat_role_id)
          groupMember.roleIds = [...ids]
          roster.put(link.vrchat_id, groupMember)
        }
      } catch (err) {
        if (isHierarchyError(err)) noteHierarchyBlock(link, pair.vrchat_role_name, err)
        else log.warn(`vrchat role update failed for ${link.vrchat_id}:`, err.message)
      }
    }

    db.setRoleState(member.id, pair.discord_role_id, finalDiscord, finalVrchat)
  }

  if (groupKnown) db.setKv(`in_group:${member.id}`, Boolean(groupMember))
  return applied.length
}

/** Resolve group membership without guessing: the roster answers free, and only an apparent leaver costs a call. */
async function resolveGroupMember(link, { verify = false } = {}) {
  if (verify) {
    try {
      const fresh = await vrc.getGroupMember(link.vrchat_id)
      roster.put(link.vrchat_id, fresh)
      return { groupMember: fresh, groupKnown: true }
    } catch (err) {
      log.warn(`group member fetch failed for ${link.vrchat_id}:`, err.message)
      return { groupMember: null, groupKnown: false }
    }
  }

  const cached = roster.get(link.vrchat_id)
  if (cached) return { groupMember: cached, groupKnown: true }
  if (!roster.isFresh()) return { groupMember: null, groupKnown: false }

  // Paging a live member list can miss a row when somebody leaves mid-walk, and absence is the one answer that strips roles.
  if (db.getKv(`in_group:${link.discord_id}`, null) === false) {
    return { groupMember: null, groupKnown: true }
  }
  return resolveGroupMember(link, { verify: true })
}

async function syncMemberNow(client, discordId, { verify = false, refreshProfile = false } = {}) {
  const link = db.getLinkByDiscord(discordId)
  if (!link) return { ok: false, reason: 'not linked' }

  const guild = await client.guilds.fetch(config.discord.guildId)
  const member = await guild.members.fetch(discordId).catch(() => null)
  if (!member) return { ok: false, reason: 'not in the Discord server' }

  let facts = db.getProfileFacts(link.vrchat_id)
  const ttlMs = config.sync.profileTtlHours * 3_600_000
  if (refreshProfile || !facts || Date.now() - facts.fetchedAt > ttlMs) {
    try {
      facts = (await refreshProfileFacts(link)) || facts
    } catch (err) {
      log.warn(`profile fetch failed for ${link.vrchat_id}:`, err.message)
    }
  }

  const { groupMember, groupKnown } = await resolveGroupMember(link, { verify })
  const changed = await reconcile(member, link, { facts, groupMember, groupKnown })
  return { ok: true, changed, inGroup: Boolean(groupMember), groupKnown, facts, link }
}

/** Public entry point, serialised per member. */
function syncOneUser(client, discordId, options = {}) {
  return withMemberLock(discordId, () => syncMemberNow(client, discordId, options))
}

// ---------------------------------------------------------------
// event driven queue
// ---------------------------------------------------------------

// The audit log feed already reads every group event, so routing them here means a VRChat side change lands within a poll.
const QUEUE_CAP = 500
const QUEUE_COOLDOWN_MS = 20_000
const QUEUE_PER_DRAIN = 5

const queue = new Map()
const queuedRecently = new Map()
let drainTimer = null
let draining = false

function requestSync(discordId, reason = 'event') {
  if (config.simpleMode) return false
  const id = String(discordId)
  if (queue.has(id)) return false
  if (Date.now() - (queuedRecently.get(id) || 0) < QUEUE_COOLDOWN_MS) return false
  if (queue.size >= QUEUE_CAP) return false
  queuedRecently.set(id, Date.now())
  queue.set(id, { reason, at: Date.now() })
  return true
}

function requestSyncByVrchat(vrchatId, reason = 'event') {
  const link = db.getLinkByVrchat(vrchatId)
  if (!link) return false
  return requestSync(link.discord_id, reason)
}

async function drainQueue() {
  if (draining || !clientRef || !queue.size) return
  draining = true
  try {
    for (const [discordId, entry] of [...queue.entries()].slice(0, QUEUE_PER_DRAIN)) {
      queue.delete(discordId)
      try {
        // The event says this member just changed, so the roster copy is known to be behind.
        await syncOneUser(clientRef, discordId, { verify: true })
        stats.eventsHandled += 1
        log.debug(`Event sync done for ${discordId} (${entry.reason})`)
      } catch (err) {
        log.warn(`event sync failed for ${discordId}:`, err.message)
      }
    }
  } finally {
    draining = false
  }
}

// ---------------------------------------------------------------
// fast path: Discord role changes push to VRChat immediately
// ---------------------------------------------------------------

async function onMemberUpdate(oldMember, newMember) {
  if (config.simpleMode) return
  const link = db.getLinkByDiscord(newMember.id)
  if (!link) return
  const pairs = db.listLinkedRoles()
  if (!pairs.length) return

  const changed = pairs.filter((p) =>
    oldMember.roles.cache.has(p.discord_role_id) !== newMember.roles.cache.has(p.discord_role_id)
  )
  if (!changed.length) return

  // Ignore the echo of the bot's own writes.
  const human = changed.filter((p) => !wasSelfEdit(newMember.id, p.discord_role_id))
  if (!human.length) return
  if (isHierarchyBlocked(link.vrchat_id)) return

  await withMemberLock(newMember.id, async () => {
    let groupMember = roster.get(link.vrchat_id)
    if (!groupMember) {
      try {
        groupMember = await vrc.getGroupMember(link.vrchat_id)
        roster.put(link.vrchat_id, groupMember)
      } catch (err) {
        log.warn('fast path group fetch failed:', err.message)
        return
      }
    }

    if (!groupMember) {
      // Outside the group: record the Discord side so a later pass does not read it as a fresh change.
      for (const pair of human) {
        db.setRoleState(newMember.id, pair.discord_role_id, newMember.roles.cache.has(pair.discord_role_id), false)
      }
      return
    }

    const vrchatRoleIds = new Set(groupMember.roleIds || [])
    for (const pair of human) {
      const nowHas = newMember.roles.cache.has(pair.discord_role_id)
      let vrchatHas = vrchatRoleIds.has(pair.vrchat_role_id)
      if (nowHas !== vrchatHas) {
        try {
          if (nowHas) await vrc.addGroupMemberRole(link.vrchat_id, pair.vrchat_role_id)
          else await vrc.removeGroupMemberRole(link.vrchat_id, pair.vrchat_role_id)
          vrchatHas = nowHas
          if (nowHas) vrchatRoleIds.add(pair.vrchat_role_id)
          else vrchatRoleIds.delete(pair.vrchat_role_id)
          groupMember.roleIds = [...vrchatRoleIds]
          roster.put(link.vrchat_id, groupMember)
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
        }
      }
      db.setRoleState(newMember.id, pair.discord_role_id, nowHas, vrchatHas)
    }
  })
}

/** A linked member rejoining Discord gets their roles back straight away. */
function onMemberAdd(member) {
  if (config.simpleMode) return
  if (!db.getLinkByDiscord(member.id)) return
  requestSync(member.id, 'rejoined Discord')
}

// ---------------------------------------------------------------
// the loop
// ---------------------------------------------------------------

/** One full pass: trackers, a roster reload when due, a rotating profile refresh, then every linked member. */
async function runCycle(client, { onProgress } = {}) {
  if (running) {
    log.debug('Previous cycle still running; skipping this tick')
    return { skipped: true }
  }
  running = true
  const startedAt = Date.now()
  let checked = 0
  let changed = 0
  let profiles = 0

  try {
    db.purgeExpiredCodes()
    pruneSelfEdits()

    const guild = await client.guilds.fetch(config.discord.guildId)
    await updateTrackers(guild)

    // Simple mode keeps the tracker channels but does no linking or role work.
    if (config.simpleMode) {
      log.debug(`Cycle done in ${Date.now() - startedAt}ms (simple mode: trackers only)`)
      return { skipped: false, checked: 0, changed: 0 }
    }

    if (Date.now() - lastMiscHealthAt > MISC_HEALTH_INTERVAL_MS) {
      lastMiscHealthAt = Date.now()
      await miscRoleHealth(client).catch((err) => log.warn('role health check failed:', err.message))
    }

    if (roster.isDue()) await roster.refresh()

    // Rotating profile refresh, oldest first, so a new link is picked up on the next cycle.
    const ttlMs = config.sync.profileTtlHours * 3_600_000
    for (const row of db.listLinksByProfileAge(config.sync.profilesPerCycle)) {
      if (Date.now() - Number(row.fetched_at) < ttlMs) break
      try {
        await refreshProfileFacts(row)
        profiles += 1
      } catch (err) {
        log.warn(`profile refresh failed for ${row.vrchat_id}:`, err.message)
      }
    }

    // Without a usable roster, ask about a few members directly so linked roles keep moving instead of stalling.
    const usable = roster.isFresh()
    if (!usable) noteRosterUnusable()
    else if (rosterAlerted) {
      rosterAlerted = false
      log.info('Group member list is readable again; back to checking every linked member per cycle.')
    }
    const links = usable
      ? db.listLinks()
      : db.listLinksByProfileAge(config.sync.profilesPerCycle)

    for (const link of links) {
      try {
        const result = await syncOneUser(client, link.discord_id, { verify: !usable })
        checked += 1
        changed += result?.changed || 0
        if (onProgress) onProgress(checked, changed)
      } catch (err) {
        log.warn(`user sync failed (${link.discord_id}):`, err.message)
      }
    }

    stats.lastError = ''
    log.debug(`Cycle done in ${Date.now() - startedAt}ms (${checked} members, ${changed} role changes, ${profiles} profiles)`)
    return { skipped: false, checked, changed, profiles }
  } catch (err) {
    stats.lastError = err.message
    log.error('Sync cycle failed:', err.message)
    discordLog.logAlert('Sync cycle failed', err.message)
    return { skipped: false, checked, changed, error: err.message }
  } finally {
    running = false
    stats.cycles += 1
    stats.lastCycleAt = Date.now()
    stats.lastCycleMs = Date.now() - startedAt
    stats.lastChecked = checked
    stats.lastChanged = changed
    stats.lastProfiles = profiles
  }
}

function status() {
  return {
    ...stats,
    running,
    links: db.countLinks(),
    pairs: db.listLinkedRoles().length,
    freshProfiles: db.countFreshProfiles(config.sync.profileTtlHours * 3_600_000),
    queued: queue.size,
    hierarchyBlocked: hierarchyBlockCount(),
    roster: roster.status(),
    intervalSeconds: config.sync.intervalSeconds,
    conflictWinner: config.sync.conflictWinner,
  }
}

function startLoop(client) {
  clientRef = client
  const intervalMs = config.sync.intervalSeconds * 1000

  if (config.simpleMode) {
    log.info('Simple mode is on: logs only, no account linking or role sync.')
  } else {
    if (!Object.keys(db.getMiscRoles()).length) {
      log.info('Misc roles are not set up yet; run /setup-misc-roles to enable 18+, VRC+, trust rank, repping, and tenure roles.')
    }
    const linkCount = db.countLinks()
    log.info(`Role sync covers all ${linkCount} linked member${linkCount === 1 ? '' : 's'} every ${config.sync.intervalSeconds}s; group events land within ${config.sync.eventDrainSeconds}s.`)

    drainTimer = setInterval(() => {
      drainQueue().catch((err) => log.warn('queue drain failed:', err.message))
    }, config.sync.eventDrainSeconds * 1000)
    drainTimer.unref?.()
  }

  setTimeout(() => runCycle(client), 10_000)
  const timer = setInterval(() => runCycle(client), intervalMs)
  timer.unref?.()
  log.info(`Auto sync every ${config.sync.intervalSeconds}s (roster every ${config.sync.rosterRefreshSeconds}s, ${config.sync.profilesPerCycle} profiles per cycle, trackers rename at most every ${RENAME_MIN_INTERVAL_MS / 60000} min)`)
}

module.exports = {
  startLoop,
  runCycle,
  syncOneUser,
  onMemberUpdate,
  onMemberAdd,
  requestSync,
  requestSyncByVrchat,
  removeMiscRoles,
  miscRoleHealth,
  getCachedGroupRoles,
  refreshProfileFacts,
  desiredMiscRoles,
  readStat,
  vrchatHealthy,
  status,
}
