'use strict'

// Offline test of the member roster cache and the event driven sync queue: paging, the failure path, and queue de-duplication.

process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'x'
process.env.DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID || '1'

const config = require('../src/config')
const db = require('../src/db')
const vrc = require('../src/vrchatApi')

let pages = []
let calls = 0
let failNext = false

vrc.getGroupMembers = async ({ offset = 0 } = {}) => {
  calls += 1
  if (failNext) throw new Error('VRChat is down')
  return pages[offset / 100] || []
}

const roster = require('../src/roster')
const sync = require('../src/sync')

function page(count, startIndex, roleIds = []) {
  return Array.from({ length: count }, (_, i) => ({
    userId: `usr_roster_${startIndex + i}`,
    user: { displayName: `Member ${startIndex + i}` },
    roleIds,
    isRepresenting: false,
    joinedAt: new Date().toISOString(),
  }))
}

let failures = 0
function check(name, pass, detail = '') {
  if (!pass) failures++
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

async function main() {
  const TEST_LINK = 'test_queue_user'
  try {
    check('starts unloaded', !roster.isLoaded() && !roster.isFresh())

    // Two full pages then a short one: three calls, then stop.
    pages = [page(100, 0, ['grol_a']), page(100, 100, ['grol_b']), page(7, 200, ['grol_a'])]
    calls = 0
    await roster.refresh({ force: true })
    check('pages until a short page', calls === 3, `calls=${calls}`)
    check('every member cached', roster.size() === 207, `size=${roster.size()}`)
    check('roster is fresh after a full walk', roster.isFresh())
    check('lookup by id works', roster.get('usr_roster_150')?.user.displayName === 'Member 150')
    check('unknown id returns null', roster.get('usr_nope') === null)
    check('role filter works', roster.withRole('grol_a').length === 107, String(roster.withRole('grol_a').length))

    // A failed walk must leave the last good cache in place.
    failNext = true
    await roster.refresh({ force: true })
    failNext = false
    check('failed walk keeps the old cache', roster.size() === 207, `size=${roster.size()}`)
    check('failed walk records the error', Boolean(roster.status().lastError))

    // Single member patching, used after an authoritative fetch.
    roster.put('usr_roster_0', null)
    check('put(null) removes a member', !roster.has('usr_roster_0'))
    roster.put('usr_roster_0', { userId: 'usr_roster_0', roleIds: [] })
    check('put restores a member', roster.has('usr_roster_0'))

    // The page cap has to stop the walk instead of looping forever.
    const realMax = config.sync.rosterMaxMembers
    config.sync.rosterMaxMembers = 200
    pages = [page(100, 0), page(100, 100), page(100, 200)]
    calls = 0
    await roster.refresh({ force: true })
    check('stops at the page cap', calls === 2, `calls=${calls}`)
    check('an incomplete walk is not fresh', !roster.isFresh())
    config.sync.rosterMaxMembers = realMax

    // Event queue: one entry per member, and unknown users are ignored.
    db.createLink(TEST_LINK, `usr_${TEST_LINK}`, 'QueueUser')
    check('queues a linked member', sync.requestSyncByVrchat(`usr_${TEST_LINK}`, 'test') === true)
    check('does not queue the same member twice', sync.requestSyncByVrchat(`usr_${TEST_LINK}`, 'test') === false)
    check('ignores an unlinked VRChat id', sync.requestSyncByVrchat('usr_not_linked_at_all', 'test') === false)
    check('queue depth is one', sync.status().queued === 1, String(sync.status().queued))

    console.log(failures === 0 ? '\nPASS (roster and queue)' : `\nFAIL (${failures} checks)`)
    process.exitCode = failures === 0 ? 0 : 1
  } finally {
    db.deleteLink(TEST_LINK)
    console.log('test rows cleaned up')
  }
}

main().catch((err) => {
  console.error('TEST ERROR:', err)
  process.exit(1)
})
