'use strict'

// Offline test of the two way linked role sync. Mocks the VRChat API and
// the Discord member, uses the real database with test-prefixed ids, and
// checks the five paths that matter:
//   1. linked but not in the group yet: nothing pushed to VRChat
//   2. joins the group later: their Discord role IS granted in VRChat
//   3. a network error during the group fetch strips nothing
//   4. role removed on the VRChat side: removed on Discord
//   5. role removed on the Discord side: removed on VRChat

process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'x'
process.env.DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID || '1'

const db = require('../src/db')
const vrc = require('../src/vrchatApi')

const TEST_DROLE = 'test_drole_sync'
const TEST_VROLE = 'grol_test_sync'
const TEST_USERS = ['test_sync_a', 'test_sync_b', 'test_sync_c', 'test_sync_d']

// ---- mock the VRChat API before the sync engine loads --------------------

let groupMemberResult = null
const vrcCalls = []

vrc.getUser = async (id) => ({ id, displayName: 'TestUser', tags: [] })
vrc.getGroupMember = async () => {
  if (typeof groupMemberResult === 'function') return groupMemberResult()
  return groupMemberResult
}
vrc.addGroupMemberRole = async (userId, roleId) => { vrcCalls.push(`add:${roleId}`) }
vrc.removeGroupMemberRole = async (userId, roleId) => { vrcCalls.push(`remove:${roleId}`) }

const sync = require('../src/sync')

// ---- mocks ----------------------------------------------------------------

const membersById = new Map()
const client = {
  guilds: {
    fetch: async () => ({ members: { fetch: async (id) => membersById.get(id) || null } }),
  },
}

function makeMember(id, { withRole }) {
  const held = new Set(withRole ? [TEST_DROLE] : [])
  const member = {
    id,
    user: { tag: `${id}#0` },
    _added: [],
    _removed: [],
    roles: {
      cache: { has: (rid) => held.has(rid) },
      add: async (rid) => { held.add(rid); member._added.push(rid) },
      remove: async (rid) => { held.delete(rid); member._removed.push(rid) },
    },
  }
  membersById.set(id, member)
  return member
}

let failures = 0
function check(name, pass, detail = '') {
  if (!pass) failures++
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

// ---- test -----------------------------------------------------------------

async function main() {
  try {
    db.setLinkedRole(TEST_DROLE, 'Test Role', TEST_VROLE, 'VRC Test Role')
    for (const id of TEST_USERS) db.createLink(id, `usr_${id}`, 'TestUser')

    // 1. Linked, holds the Discord role, but not in the group yet.
    const a = makeMember('test_sync_a', { withRole: true })
    groupMemberResult = null
    await sync.syncOneUser(client, 'test_sync_a')
    check('not in group: nothing pushed to VRChat', !vrcCalls.includes(`add:${TEST_VROLE}`), vrcCalls.join(' '))
    check('not in group: membership remembered as out', db.getKv('in_group:test_sync_a', null) === false)

    // 2. They join the group: the Discord role gets granted in VRChat.
    groupMemberResult = { roleIds: [], isRepresenting: false, joinedAt: new Date().toISOString() }
    await sync.syncOneUser(client, 'test_sync_a')
    check('join: Discord role granted in VRChat', vrcCalls.includes(`add:${TEST_VROLE}`), vrcCalls.join(' '))
    const stateA = db.getRoleState('test_sync_a', TEST_DROLE)
    check('join: state settles on both sides', stateA?.had_discord === 1 && stateA?.had_vrchat === 1)
    check('join: Discord role untouched', a._removed.length === 0)

    // 3. Network error during the group fetch must strip nothing.
    const b = makeMember('test_sync_b', { withRole: true })
    db.setRoleState('test_sync_b', TEST_DROLE, true, true)
    db.setKv('in_group:test_sync_b', true)
    groupMemberResult = () => { throw new Error('network down') }
    const callsBefore = vrcCalls.length
    await sync.syncOneUser(client, 'test_sync_b')
    const stateB = db.getRoleState('test_sync_b', TEST_DROLE)
    check('fetch error: Discord role kept', !b._removed.includes(TEST_DROLE), b._removed.join(' '))
    check('fetch error: no VRChat calls', vrcCalls.length === callsBefore)
    check('fetch error: state untouched', stateB?.had_discord === 1 && stateB?.had_vrchat === 1)

    // 4. Role removed on the VRChat side mirrors to Discord.
    const c = makeMember('test_sync_c', { withRole: true })
    db.setRoleState('test_sync_c', TEST_DROLE, true, true)
    db.setKv('in_group:test_sync_c', true)
    groupMemberResult = { roleIds: [], isRepresenting: false, joinedAt: new Date().toISOString() }
    await sync.syncOneUser(client, 'test_sync_c')
    check('VRChat removal mirrors to Discord', c._removed.includes(TEST_DROLE), c._removed.join(' '))

    // 5. Role removed on the Discord side mirrors to VRChat.
    makeMember('test_sync_d', { withRole: false })
    db.setRoleState('test_sync_d', TEST_DROLE, true, true)
    db.setKv('in_group:test_sync_d', true)
    groupMemberResult = { roleIds: [TEST_VROLE], isRepresenting: false, joinedAt: new Date().toISOString() }
    await sync.syncOneUser(client, 'test_sync_d')
    check('Discord removal mirrors to VRChat', vrcCalls.includes(`remove:${TEST_VROLE}`), vrcCalls.join(' '))

    console.log(failures === 0 ? '\nPASS (two way sync)' : `\nFAIL (${failures} checks)`)
    process.exitCode = failures === 0 ? 0 : 1
  } finally {
    // Remove every test row from the real database.
    db.removeLinkedRole(TEST_DROLE)
    for (const id of TEST_USERS) {
      db.deleteLink(id)
      db.getDb().prepare('DELETE FROM kv WHERE key = ?').run(`in_group:${id}`)
    }
    console.log('test rows cleaned up')
  }
}

main().catch((err) => {
  console.error('TEST ERROR:', err)
  process.exit(1)
})
