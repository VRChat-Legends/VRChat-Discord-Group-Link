'use strict'

// Read only probe: which VRChat API endpoints does the bot's account
// actually have access to for this group? GET requests only, paced by the
// normal global throttle so it cannot trip the rate limit.

process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'x'
process.env.DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID || '1'

const config = require('../src/config')
const { VRCHAT_API, UA, throttledFetch, getAuthCookies } = require('../src/vrchatAuth')

const GID = config.vrchat.groupId
const ME = 'usr_59151047-ed32-4073-ab57-b31806805857'
const SAMPLE_USER = 'usr_22a94aa8-de10-45f3-b151-de057b057b2b'

const PROBES = [
  ['group bans', `/groups/${GID}/bans?n=5`],
  ['join requests', `/groups/${GID}/requests?n=5`],
  ['group invites sent', `/groups/${GID}/invites?n=5`],
  ['group posts', `/groups/${GID}/posts?n=5`],
  ['group announcement', `/groups/${GID}/announcement`],
  ['group members page', `/groups/${GID}/members?n=3&offset=0`],
  ['group members sorted by joined', `/groups/${GID}/members?n=3&sort=joinedAt%3Adesc`],
  ['group member search', `/groups/${GID}/members?n=3&search=a`],
  ['group calendar', `/groups/${GID}/calendar?n=3`],
  ['group galleries', `/groups/${GID}/galleries`],
  ['group permissions list', '/groups/permissions'],
  ['my groups', `/users/${ME}/groups`],
  ['user represented group', `/users/${SAMPLE_USER}/groups/represented`],
  ['user groups (other)', `/users/${SAMPLE_USER}/groups`],
  ['notifications', '/auth/user/notifications?n=5'],
  ['friends online', '/auth/user/friends?n=5&offline=false'],
  ['visits (online now)', '/visits'],
  ['system time', '/time'],
  ['instance detail', null], // filled from group instances below
]

async function get(path) {
  const cookies = await getAuthCookies()
  const res = await throttledFetch(`${VRCHAT_API}${path}`, {
    headers: { Cookie: cookies, 'User-Agent': UA },
  })
  const text = await res.text().catch(() => '')
  let json = null
  try { json = JSON.parse(text) } catch { /* not json */ }
  return { status: res.status, json, text }
}

function describe(json) {
  if (Array.isArray(json)) {
    const first = json[0]
    return `array(${json.length})` + (first && typeof first === 'object' ? ` keys: ${Object.keys(first).slice(0, 14).join(',')}` : '')
  }
  if (json && typeof json === 'object') return `object keys: ${Object.keys(json).slice(0, 18).join(',')}`
  return String(json).slice(0, 80)
}

async function main() {
  console.log(`Group: ${GID}\n`)

  // Grab a live instance id for the instance detail probe.
  const inst = await get(`/groups/${GID}/instances`)
  const live = Array.isArray(inst.json) ? inst.json[0] : null
  if (live?.location || live?.instanceId) {
    PROBES[PROBES.length - 1][1] = `/instances/${encodeURIComponent(live.location || live.instanceId)}`
  } else {
    PROBES.pop()
    console.log('(no live group instance right now, skipping instance detail probe)\n')
  }

  for (const [label, path] of PROBES) {
    if (!path) continue
    try {
      const r = await get(path)
      const note = r.status === 200 ? describe(r.json) : (r.json?.error?.message || r.text.slice(0, 100))
      console.log(`${r.status === 200 ? 'OK  ' : 'FAIL'} ${String(r.status).padEnd(4)} ${label.padEnd(28)} ${note}`)
    } catch (err) {
      console.log(`ERR       ${label.padEnd(28)} ${err.message}`)
    }
  }
}

main().catch((err) => {
  console.error('PROBE ERROR:', err.message)
  process.exit(1)
})
