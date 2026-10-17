// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'

// Legends Alley role sync. Polls the Alley backend for every community and
// who runs it, then keeps a tidy block of Discord roles in step:
//
//   ──── Legends Alley ────     divider, no permissions, never assigned
//   Booth Owner                 owns an active community
//   Booth Manager               manages one
//   Booth Team                  is on a booth team
//   Booth: <community>          one per active community, everyone on it
//
// The whole block sits together under the divider in that order, community
// roles alphabetical, so the role list never gets cluttered. A person can
// be on more than one community (the Alley caps it), they simply get every
// role that applies. A community staff have switched off grants nothing
// until it is switched back on; its role is kept, empty, so turning it on
// again needs no setup. Roles for deleted communities are removed.
//
// Only roles in this block are ever touched. Off unless ALLEY_BOT_KEY is set.

const config = require('./config')
const db = require('./db')
const logger = require('./logger')
const discordLog = require('./discordLog')
const setupBackup = require('./setupBackup')

const log = logger('AlleyRoles')

const KV_KEY = 'alley_roles'
const REASON = 'Legends Alley role sync'

const GENERIC = [
  { key: 'owner', name: 'Booth Owner', color: 0xff007a },
  { key: 'manager', name: 'Booth Manager', color: 0x6b46c1 },
  { key: 'team', name: 'Booth Team', color: 0x1fd1ed },
]

/* ─── planning, pure ─── */

function communityRoleName(name) {
  const format = config.alley.communityRoleFormat || 'Booth: {name}'
  return format.replace('{name}', String(name || '').trim()).slice(0, 100)
}

// who should hold what, from the backend's state
function plan(state) {
  const generic = new Map() // discordId -> Set of generic keys
  const community = new Map() // communityId -> { name, active, members: Set }
  const add = (id, key) => {
    if (!id) return
    const sid = String(id)
    if (!generic.has(sid)) generic.set(sid, new Set())
    generic.get(sid).add(key)
  }
  for (const c of state?.communities || []) {
    if (!c?.id) continue
    const members = new Set()
    const entry = { name: String(c.name || 'Community'), active: c.active === true, members }
    community.set(String(c.id), entry)
    if (!entry.active) continue
    const managers = Array.isArray(c.managerDiscordIds) && c.managerDiscordIds.length
      ? c.managerDiscordIds
      : c.managerDiscordId ? [c.managerDiscordId] : []
    if (c.ownerDiscordId) {
      add(c.ownerDiscordId, 'owner')
      members.add(String(c.ownerDiscordId))
    }
    for (const id of managers) {
      if (!id) continue
      add(id, 'manager')
      members.add(String(id))
    }
    for (const member of c.teamMembers || []) {
      if (!member?.discordId) continue
      add(member.discordId, 'team')
      members.add(String(member.discordId))
    }
  }
  return { generic, community }
}

// the block from top to bottom: divider, generic roles, then communities by name
function desiredOrder(ids, communities) {
  const order = [ids.divider]
  for (const def of GENERIC) order.push(ids[def.key])
  const sorted = [...communities.entries()]
    .filter(([id]) => ids.community[id])
    .sort((a, b) => a[1].name.localeCompare(b[1].name, undefined, { sensitivity: 'base' }))
  for (const [id] of sorted) order.push(ids.community[id])
  return order.filter(Boolean)
}

/* ─── backend ─── */

async function fetchState() {
  const url = config.alley.apiUrl.replace(/\/+$/, '') + '/api/internal/roles/state'
  const res = await fetch(url, {
    headers: { 'x-bot-key': config.alley.botKey, 'user-agent': 'VRChat-Discord-Group-Link' },
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) throw new Error(`Alley backend answered ${res.status}`)
  return res.json()
}

/* ─── discord ─── */

function savedIds() {
  const saved = db.getKv(KV_KEY, null)
  return {
    divider: saved?.divider || null,
    owner: saved?.owner || null,
    manager: saved?.manager || null,
    team: saved?.team || null,
    community: saved?.community && typeof saved.community === 'object' ? { ...saved.community } : {},
  }
}

function saveIds(ids) {
  db.setKv(KV_KEY, ids)
  setupBackup.saveAlleyRoles(ids)
}

function botTop(guild) {
  return guild.members.me?.roles?.highest?.position ?? 0
}

// find a role by stored id, else adopt one by name, else create it
async function ensureRole(guild, id, name, options) {
  let role = id ? guild.roles.cache.get(id) : null
  if (!role) role = guild.roles.cache.find((r) => r.name === name && !r.managed) || null
  if (!role) {
    role = await guild.roles.create({ name, mentionable: false, hoist: false, permissions: [], reason: REASON, ...options })
    log.info(`Created @${name}`)
  } else if (role.name !== name && role.editable) {
    await role.setName(name, REASON)
  }
  return role
}

async function ensureRoles(guild, communities) {
  const ids = savedIds()
  const fresh = !ids.divider || !guild.roles.cache.get(ids.divider)
  const divider = await ensureRole(guild, ids.divider, config.alley.dividerName, { color: 0x2b2d31 })
  ids.divider = divider.id
  // a brand new divider lands at the bottom of the list, tidy lifts it
  // to just under my own role
  ids.freshDivider = fresh
  for (const def of GENERIC) {
    const role = await ensureRole(guild, ids[def.key], def.name, { color: def.color })
    ids[def.key] = role.id
  }
  if (config.alley.communityRoles) {
    for (const [id, entry] of communities) {
      const role = await ensureRole(guild, ids.community[id], communityRoleName(entry.name), {})
      ids.community[id] = role.id
    }
  }
  // communities that no longer exist lose their role
  for (const [id, roleId] of Object.entries(ids.community)) {
    if (config.alley.communityRoles && communities.has(id)) continue
    const role = guild.roles.cache.get(roleId)
    if (role?.editable) {
      await role.delete(REASON).catch((err) => log.warn(`could not delete ${role.name}:`, err.message))
      log.info(`Removed @${role.name}, its community is gone`)
    }
    delete ids.community[id]
  }
  const { freshDivider, ...stored } = ids
  saveIds(stored)
  return ids
}

// keep the block together under the divider, in order. the whole role list
// is laid out once and only the roles whose spot changes are sent, so a tidy
// server costs nothing and the result never depends on how discord shuffles
// roles one move at a time
function layout(guild, ids, communities) {
  const block = desiredOrder(ids, communities).map((id) => guild.roles.cache.get(id)).filter(Boolean)
  if (block.length < 2) return []
  const inBlock = new Set(block.map((role) => role.id))
  const all = [...guild.roles.cache.values()]
    .filter((role) => role.id !== guild.id)
    .sort((a, b) => b.position - a.position)
  const rest = all.filter((role) => !inBlock.has(role.id))
  const top = guild.members.me?.roles?.highest
  let at
  if (ids.freshDivider && top) {
    // straight under my own role
    at = rest.findIndex((role) => role.id === top.id) + 1
  } else {
    // wherever the divider sits now
    at = rest.filter((role) => role.position > block[0].position).length
  }
  const ordered = [...rest.slice(0, at), ...block, ...rest.slice(at)]
  const moves = []
  ordered.forEach((role, i) => {
    const position = ordered.length - i
    if (role.position !== position) moves.push({ role: role.id, position })
  })
  return moves
}

async function tidy(guild, ids, communities) {
  const divider = guild.roles.cache.get(ids.divider)
  if (!divider) return false
  if (divider.position >= botTop(guild) && !ids.freshDivider) {
    log.warn('The Legends Alley roles sit above my highest role, move my role up so I can manage them.')
    return false
  }
  const moves = layout(guild, ids, communities)
  if (!moves.length) return false
  await guild.roles.setPositions(moves)
  log.info(`Tidied the Legends Alley roles (${moves.length} moved)`)
  return true
}

// add and remove so every managed role is held by exactly the planned people
async function applyMembers(guild, ids, planned) {
  const want = new Map() // roleId -> Set of discordIds
  for (const def of GENERIC) want.set(ids[def.key], new Set())
  for (const [discordId, keys] of planned.generic) {
    for (const key of keys) want.get(ids[key])?.add(discordId)
  }
  if (config.alley.communityRoles) {
    for (const [id, entry] of planned.community) {
      if (ids.community[id]) want.set(ids.community[id], new Set(entry.members))
    }
  }

  let added = 0
  let removed = 0
  for (const [roleId, holders] of want) {
    const role = guild.roles.cache.get(roleId)
    if (!role || !role.editable) continue
    for (const member of role.members.values()) {
      if (holders.has(member.id)) continue
      try {
        await member.roles.remove(role, REASON)
        removed++
        discordLog.logRoleChange({ discordId: member.id, action: 'removed', side: 'Discord', roleName: role.name, drivenBy: 'Legends Alley' })
      } catch (err) {
        log.warn(`could not remove ${role.name} from ${member.id}:`, err.message)
      }
    }
    for (const discordId of holders) {
      const member = guild.members.cache.get(discordId)
      if (!member || member.roles.cache.has(roleId)) continue
      try {
        await member.roles.add(role, REASON)
        added++
        discordLog.logRoleChange({ discordId, action: 'added', side: 'Discord', roleName: role.name, drivenBy: 'Legends Alley' })
      } catch (err) {
        log.warn(`could not give ${role.name} to ${discordId}:`, err.message)
      }
    }
  }
  return { added, removed }
}

/* ─── loop ─── */

let running = false
let lastFull = 0

async function reconcile(client, { full = false } = {}) {
  if (running) return null
  running = true
  try {
    const guild = client.guilds.cache.get(config.discord.guildId) || await client.guilds.fetch(config.discord.guildId)
    const state = await fetchState()
    const planned = plan(state)
    if (full || Date.now() - lastFull > config.alley.reconcileSeconds * 1000) {
      await guild.members.fetch()
      lastFull = Date.now()
    } else {
      // only people the backend just named need fetching between full passes
      const ids = [...planned.generic.keys()].filter((id) => !guild.members.cache.has(id))
      if (ids.length) await guild.members.fetch({ user: ids }).catch(() => null)
    }
    const ids = await ensureRoles(guild, planned.community)
    await tidy(guild, ids, planned.community)
    const result = await applyMembers(guild, ids, planned)
    if (result.added || result.removed) log.info(`Alley roles: ${result.added} added, ${result.removed} removed`)
    return result
  } catch (err) {
    log.warn('Alley role sync failed:', err.message)
    return null
  } finally {
    running = false
  }
}

function start(client) {
  if (config.simpleMode || !config.alley.enabled) return
  log.info(`Legends Alley role sync on, polling ${config.alley.apiUrl} every ${config.alley.pollSeconds}s`)
  reconcile(client, { full: true })
  const timer = setInterval(() => reconcile(client), config.alley.pollSeconds * 1000)
  timer.unref?.()
}

module.exports = { start, reconcile, plan, desiredOrder, layout, communityRoleName, GENERIC }
