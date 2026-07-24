'use strict'

// VRChat API surface for the group link bot. Every call goes through the
// throttled fetch in vrchatAuth.js and retries once on a 401 after forcing
// a re-login. Endpoints kept to the minimum the bot needs.

const config = require('./config')
const logger = require('./logger')
const { VRCHAT_API, UA, throttledFetch, getAuthCookies, invalidateAuthCookies } = require('./vrchatAuth')

const log = logger('VRChatAPI')

async function authedRequest(method, apiPath, { body, retried = false } = {}) {
  const cookies = await getAuthCookies()
  if (!cookies) throw new Error('VRChat authentication is unavailable')

  const res = await throttledFetch(`${VRCHAT_API}${apiPath}`, {
    method,
    headers: {
      Cookie: cookies,
      'User-Agent': UA,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })

  if ((res.status === 401 || res.status === 403) && !retried) {
    log.warn(`HTTP ${res.status} on ${method} ${apiPath}; forcing re-login and retrying once`)
    invalidateAuthCookies()
    await getAuthCookies({ force: true })
    return authedRequest(method, apiPath, { body, retried: true })
  }

  if (res.status === 429) {
    // Should not happen with our pacing, but if VRChat says slow down, we
    // respect it and surface a clear error instead of hammering.
    log.warn(`VRChat returned 429 on ${apiPath}; backing off this cycle`)
    throw new Error('VRChat rate limited the request (429)')
  }

  if (res.status === 404) return null

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`VRChat API ${method} ${apiPath} failed: HTTP ${res.status} ${text.slice(0, 200)}`)
  }

  if (res.status === 204) return {}
  return res.json()
}

// ---------------------------------------------------------------
// users
// ---------------------------------------------------------------

function getUser(userId) {
  return authedRequest('GET', `/users/${encodeURIComponent(userId)}`)
}

async function searchUsers(query, n = 5) {
  const data = await authedRequest('GET', `/users?search=${encodeURIComponent(query)}&n=${n}`)
  return Array.isArray(data) ? data : []
}

/**
 * Resolve either a usr_ id or a display name to a full user object.
 */
async function resolveUser(input) {
  const raw = String(input || '').trim()
  if (!raw) return null
  if (/^usr_[0-9a-f-]{36}$/i.test(raw)) return getUser(raw)
  const matches = await searchUsers(raw, 5)
  const exact = matches.find((u) => String(u.displayName || '').toLowerCase() === raw.toLowerCase())
  const pick = exact || matches[0]
  if (!pick) return null
  // Search results are trimmed objects; fetch the full profile.
  return getUser(pick.id)
}

// ---------------------------------------------------------------
// group
// ---------------------------------------------------------------

function getGroup() {
  return authedRequest('GET', `/groups/${encodeURIComponent(config.vrchat.groupId)}`)
}

async function getGroupRoles() {
  const data = await authedRequest('GET', `/groups/${encodeURIComponent(config.vrchat.groupId)}/roles`)
  return Array.isArray(data) ? data : []
}

function getGroupMember(userId) {
  return authedRequest(
    'GET',
    `/groups/${encodeURIComponent(config.vrchat.groupId)}/members/${encodeURIComponent(userId)}`
  )
}

function addGroupMemberRole(userId, groupRoleId) {
  return authedRequest(
    'PUT',
    `/groups/${encodeURIComponent(config.vrchat.groupId)}/members/${encodeURIComponent(userId)}/roles/${encodeURIComponent(groupRoleId)}`
  )
}

function removeGroupMemberRole(userId, groupRoleId) {
  return authedRequest(
    'DELETE',
    `/groups/${encodeURIComponent(config.vrchat.groupId)}/members/${encodeURIComponent(userId)}/roles/${encodeURIComponent(groupRoleId)}`
  )
}

async function getGroupInstances() {
  const data = await authedRequest('GET', `/groups/${encodeURIComponent(config.vrchat.groupId)}/instances`)
  return Array.isArray(data) ? data : []
}

/**
 * Group audit logs, newest first. Pass startDate (ISO) to only get entries
 * after that time. Returns { results, totalCount, hasNext }.
 */
async function getGroupAuditLogs({ startDate, n = 100, offset = 0 } = {}) {
  const params = new URLSearchParams()
  params.set('n', String(Math.min(100, Math.max(1, n))))
  params.set('offset', String(offset))
  if (startDate) params.set('startDate', startDate)
  const data = await authedRequest(
    'GET',
    `/groups/${encodeURIComponent(config.vrchat.groupId)}/auditLogs?${params}`
  )
  return data && Array.isArray(data.results) ? data : { results: [], totalCount: 0, hasNext: false }
}

// ---------------------------------------------------------------
// profile parsing helpers
// ---------------------------------------------------------------

// VRChat trust tags map to ranks with the classic one-step offset.
const TRUST_RANKS = [
  { key: 'trusted', label: 'Trusted User', tag: 'system_trust_veteran' },
  { key: 'known', label: 'Known User', tag: 'system_trust_trusted' },
  { key: 'user', label: 'User', tag: 'system_trust_known' },
  { key: 'new_user', label: 'New User', tag: 'system_trust_basic' },
  { key: 'visitor', label: 'Visitor', tag: null },
]

function getTrustRank(user) {
  const tags = Array.isArray(user?.tags) ? user.tags : []
  for (const rank of TRUST_RANKS) {
    if (rank.tag && tags.includes(rank.tag)) return rank
  }
  return TRUST_RANKS[TRUST_RANKS.length - 1]
}

function hasVrcPlus(user) {
  const tags = Array.isArray(user?.tags) ? user.tags : []
  return tags.includes('system_supporter') || tags.includes('system_early_adopter')
}

function isAgeVerified18Plus(user) {
  // ageVerificationStatus is "18+" for verified adults; older accounts may
  // only have ageVerified. Treat either as verified.
  return user?.ageVerificationStatus === '18+' || user?.ageVerified === true
}

module.exports = {
  getUser,
  searchUsers,
  resolveUser,
  getGroup,
  getGroupRoles,
  getGroupMember,
  addGroupMemberRole,
  removeGroupMemberRole,
  getGroupInstances,
  getGroupAuditLogs,
  getTrustRank,
  hasVrcPlus,
  isAgeVerified18Plus,
  TRUST_RANKS,
}
