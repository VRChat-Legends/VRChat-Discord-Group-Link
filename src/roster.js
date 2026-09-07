// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict'

// The whole group member list cached, one VRChat call per 100 members, so the sync can check every linked member every cycle.

const config = require('./config')
const logger = require('./logger')
const vrc = require('./vrchatApi')

const log = logger('Roster')

const PAGE_SIZE = 100

let members = new Map()
let loadedAt = 0
let complete = false
let lastError = ''
let lastCalls = 0
let lastDurationMs = 0
let inFlight = null

function ageMs() {
  return loadedAt ? Date.now() - loadedAt : Infinity
}

function isLoaded() {
  return loadedAt > 0
}

// Past twice the refresh interval, absent might just mean not fetched recently, so callers must verify rather than trust it.
function isFresh() {
  return isLoaded() && complete && ageMs() < config.sync.rosterRefreshSeconds * 2000
}

function isDue() {
  return ageMs() >= config.sync.rosterRefreshSeconds * 1000
}

function get(vrchatId) {
  return members.get(String(vrchatId)) || null
}

function has(vrchatId) {
  return members.has(String(vrchatId))
}

function size() {
  return members.size
}

function all() {
  return [...members.values()]
}

/** Members holding a group role. Only meaningful once the roster is loaded. */
function withRole(groupRoleId) {
  const id = String(groupRoleId)
  return all().filter((m) => Array.isArray(m?.roleIds) && m.roleIds.includes(id))
}

/** Replace one member from an authoritative fetch; null records that they are not in the group. */
function put(vrchatId, member) {
  const id = String(vrchatId)
  if (member) members.set(id, member)
  else members.delete(id)
}

function status() {
  return {
    size: members.size,
    loadedAt,
    ageMs: ageMs(),
    complete,
    fresh: isFresh(),
    refreshing: Boolean(inFlight),
    lastError,
    lastCalls,
    lastDurationMs,
  }
}

async function fetchAll() {
  const next = new Map()
  let calls = 0
  // joinedAt:asc keeps existing members at stable offsets: anyone joining mid-walk lands past the end instead of shifting the window.
  for (let offset = 0; offset < config.sync.rosterMaxMembers; offset += PAGE_SIZE) {
    const page = await vrc.getGroupMembers({ n: PAGE_SIZE, offset, sort: 'joinedAt:asc' })
    calls += 1
    for (const m of page) {
      const id = m?.userId || m?.user?.id
      if (id) next.set(String(id), m)
    }
    if (page.length < PAGE_SIZE) return { next, calls, whole: true }
  }
  return { next, calls, whole: false }
}

/** Reload the roster. Concurrent callers share one walk, and a failed walk keeps the previous cache. */
async function refresh({ force = false } = {}) {
  if (inFlight) return inFlight
  if (!force && !isDue()) return status()

  const startedAt = Date.now()
  inFlight = (async () => {
    try {
      const { next, calls, whole } = await fetchAll()
      members = next
      loadedAt = Date.now()
      complete = whole
      lastError = ''
      lastCalls = calls
      lastDurationMs = Date.now() - startedAt
      if (!whole) {
        log.warn(`Group has more than ${config.sync.rosterMaxMembers} members; raise sync.roster_max_members in config.yml`)
      }
      log.info(`Roster refreshed: ${members.size} members in ${calls} API call${calls === 1 ? '' : 's'} (${lastDurationMs}ms)`)
    } catch (err) {
      lastError = err.vrchatMessage || err.message
      log.warn('Roster refresh failed:', lastError)
    } finally {
      inFlight = null
    }
    return status()
  })()

  return inFlight
}

module.exports = {
  refresh,
  get,
  has,
  put,
  all,
  withRole,
  size,
  status,
  isLoaded,
  isFresh,
  isDue,
  ageMs,
}
