'use strict'

// Offline test of the role sync engine: mocked VRChat API, mocked roster, mocked Discord member, real database with test-prefixed ids.

process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'x'
process.env.DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID || '1'

const db = require('../src/db')
const vrc = require('../src/vrchatApi')
const roster = require('../src/roster')

const GUILD_ID = 'test_guild'
const TEST_DROLE = 'test_drole_sync'
const TEST_VROLE = 'grol_test_sync'
const TEST_DROLE2 = 'test_drole_sync2'
const TEST_VROLE2 = 'grol_test_sync2'
const TEST_USERS = [
  'test_sync_a', 'test_sync_b', 'test_sync_c', 'test_sync_d',
  'test_sync_e', 'test_sync_f', 'test_sync_g', 'test_sync_h',
]

// ---- mock the VRChat API and the roster before the sync engine loads -----

let groupMemberResult = null
const vrcCalls = []

vrc.getUser = async (id) => {
  vrcCalls.push(`user:${id}`)
  return { id, displayName: 'TestUser', tags: [] }
}
vrc.getGroupMember = async (id) => {
  vrcCalls.push(`member:${id}`)
  if (typeof groupMemberResult === 'function') return groupMemberResult()
  return groupMemberResult
}
vrc.addGroupMemberRole = async (userId, roleId) => { vrcCalls.push(`add:${roleId}`) }
vrc.removeGroupMemberRole = async (userId, roleId) => { vrcCalls.push(`remove:${roleId}`) }

let rosterFresh = false
const rosterMembers = new Map()
roster.isFresh = () => rosterFresh
roster.isLoaded = () => rosterFresh
roster.isDue = () => false
roster.get = (id) => rosterMembers.get(String(id)) || null
roster.has = (id) => rosterMembers.has(String(id))
roster.put = (id, member) => {
  if (member) rosterMembers.set(String(id), member)
  else rosterMembers.delete(String(id))
}

const sync = require('../src/sync')

// ---- Discord mocks --------------------------------------------------------

const membersById = new Map()
const client = {
  guilds: {
    fetch: async () => ({
      id: GUILD_ID,
      members: { fetch: async (id) => membersById.get(id) || null },
    }),
  },
}

function makeMember(id, { roles = [] } = {}) {
  const held = new Set([GUILD_ID, ...roles])
  const member = {
    id,
    guild: { id: GUILD_ID },
    user: { tag: `${id}#0` },
    _added: [],
    _removed: [],
    _sets: 0,
    roles: {
      cache: {
        has: (rid) => held.has(rid),
        filter: (fn) => {
          const kept = [...held].map((rid) => ({ id: rid })).filter(fn)
          return { map: (project) => kept.map(project) }
        },
      },
      add: async (rid) => { held.add(rid); member._added.push(rid) },
      remove: async (rid) => { held.delete(rid); member._removed.push(rid) },
      set: async (ids) => {
        const next = new Set(ids)
        for (const rid of held) if (!next.has(rid) && rid !== GUILD_ID) member._removed.push(rid)
        for (const rid of next) if (!held.has(rid)) member._added.push(rid)
        held.clear()
        held.add(GUILD_ID)
        for (const rid of next) held.add(rid)
        member._sets += 1
      },
    },
  }
  membersById.set(id, member)
  return member
}

function groupMember(roleIds = []) {
  return { roleIds, isRepresenting: false, joinedAt: new Date().toISOString() }
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
    const a = makeMember('test_sync_a', { roles: [TEST_DROLE] })
    groupMemberResult = null
    await sync.syncOneUser(client, 'test_sync_a', { verify: true })
    check('not in group: nothing pushed to VRChat', !vrcCalls.includes(`add:${TEST_VROLE}`), vrcCalls.join(' '))
    check('not in group: membership remembered as out', db.getKv('in_group:test_sync_a', null) === false)
    check('not in group: Discord role kept', !a._removed.includes(TEST_DROLE))

    // 2. They join the group: the Discord role gets granted in VRChat.
    groupMemberResult = groupMember([])
    await sync.syncOneUser(client, 'test_sync_a', { verify: true })
    check('join: Discord role granted in VRChat', vrcCalls.includes(`add:${TEST_VROLE}`), vrcCalls.join(' '))
    const stateA = db.getRoleState('test_sync_a', TEST_DROLE)
    check('join: state settles on both sides', stateA?.had_discord === 1 && stateA?.had_vrchat === 1)
    check('join: Discord role untouched', a._removed.length === 0)

    // 3. Network error during the group fetch must strip nothing.
    const b = makeMember('test_sync_b', { roles: [TEST_DROLE] })
    db.setRoleState('test_sync_b', TEST_DROLE, true, true)
    db.setKv('in_group:test_sync_b', true)
    groupMemberResult = () => { throw new Error('network down') }
    const callsBefore = vrcCalls.length
    await sync.syncOneUser(client, 'test_sync_b', { verify: true })
    const stateB = db.getRoleState('test_sync_b', TEST_DROLE)
    check('fetch error: Discord role kept', !b._removed.includes(TEST_DROLE), b._removed.join(' '))
    check('fetch error: no VRChat role calls', vrcCalls.slice(callsBefore).every((c) => !/^(add|remove):/.test(c)))
    check('fetch error: state untouched', stateB?.had_discord === 1 && stateB?.had_vrchat === 1)

    // 4. Role removed on the VRChat side mirrors to Discord.
    const c = makeMember('test_sync_c', { roles: [TEST_DROLE] })
    db.setRoleState('test_sync_c', TEST_DROLE, true, true)
    db.setKv('in_group:test_sync_c', true)
    groupMemberResult = groupMember([])
    await sync.syncOneUser(client, 'test_sync_c', { verify: true })
    check('VRChat removal mirrors to Discord', c._removed.includes(TEST_DROLE), c._removed.join(' '))

    // 5. Role removed on the Discord side mirrors to VRChat.
    makeMember('test_sync_d')
    db.setRoleState('test_sync_d', TEST_DROLE, true, true)
    db.setKv('in_group:test_sync_d', true)
    groupMemberResult = groupMember([TEST_VROLE])
    await sync.syncOneUser(client, 'test_sync_d', { verify: true })
    check('Discord removal mirrors to VRChat', vrcCalls.includes(`remove:${TEST_VROLE}`), vrcCalls.join(' '))

    // 6. A roster backed pass answers from cache and spends nothing.
    rosterFresh = true
    const e = makeMember('test_sync_e')
    rosterMembers.set('usr_test_sync_e', groupMember([TEST_VROLE]))
    db.setKv('in_group:test_sync_e', true)
    db.setProfileFacts('usr_test_sync_e', { displayName: 'TestUser', trustKey: 'visitor', vrcPlus: false, age18: false })
    const beforeRoster = vrcCalls.length
    await sync.syncOneUser(client, 'test_sync_e')
    check('roster pass: VRChat role granted on Discord', e._added.includes(TEST_DROLE), e._added.join(' '))
    check('roster pass: zero VRChat calls', vrcCalls.length === beforeRoster, vrcCalls.slice(beforeRoster).join(' '))

    // 7. Absent from a fresh roster is confirmed before anything is stripped.
    const f = makeMember('test_sync_f', { roles: [TEST_DROLE] })
    db.setRoleState('test_sync_f', TEST_DROLE, true, true)
    db.setKv('in_group:test_sync_f', true)
    db.setProfileFacts('usr_test_sync_f', { displayName: 'TestUser', trustKey: 'visitor', vrcPlus: false, age18: false })
    groupMemberResult = groupMember([TEST_VROLE])
    const beforeConfirm = vrcCalls.length
    await sync.syncOneUser(client, 'test_sync_f')
    check('roster miss: confirmed with a direct fetch', vrcCalls.slice(beforeConfirm).includes('member:usr_test_sync_f'))
    check('roster miss: role kept once VRChat says they are in', !f._removed.includes(TEST_DROLE), f._removed.join(' '))

    // 8. Several roles moving at once become one Discord write.
    db.setLinkedRole(TEST_DROLE2, 'Test Role 2', TEST_VROLE2, 'VRC Test Role 2')
    const g = makeMember('test_sync_g')
    rosterMembers.set('usr_test_sync_g', groupMember([TEST_VROLE, TEST_VROLE2]))
    db.setKv('in_group:test_sync_g', true)
    db.setProfileFacts('usr_test_sync_g', { displayName: 'TestUser', trustKey: 'visitor', vrcPlus: false, age18: false })
    await sync.syncOneUser(client, 'test_sync_g')
    check('two roles: both granted', g._added.includes(TEST_DROLE) && g._added.includes(TEST_DROLE2), g._added.join(' '))
    check('two roles: one Discord write', g._sets === 1, `sets=${g._sets}`)
    db.removeLinkedRole(TEST_DROLE2)

    // 9. The bot's own edits must not bounce back through the fast path.
    const h = makeMember('test_sync_h')
    rosterMembers.set('usr_test_sync_h', groupMember([TEST_VROLE]))
    db.setKv('in_group:test_sync_h', true)
    db.setProfileFacts('usr_test_sync_h', { displayName: 'TestUser', trustKey: 'visitor', vrcPlus: false, age18: false })
    await sync.syncOneUser(client, 'test_sync_h')
    const beforeEcho = vrcCalls.length
    // Replay the gateway event the bot's own write would produce.
    await sync.onMemberUpdate({ roles: { cache: { has: () => false } } }, h)
    check('echo: own edit ignored by the fast path', vrcCalls.length === beforeEcho, vrcCalls.slice(beforeEcho).join(' '))

    // A real change from a human still goes through.
    const i = makeMember('test_sync_h_manual')
    db.createLink('test_sync_h_manual', 'usr_test_sync_h_manual', 'TestUser')
    rosterMembers.set('usr_test_sync_h_manual', groupMember([]))
    await i.roles.add(TEST_DROLE)
    await sync.onMemberUpdate({ roles: { cache: { has: () => false } } }, i)
    check('human change still pushes to VRChat', vrcCalls.includes(`add:${TEST_VROLE}`))

    console.log(failures === 0 ? '\nPASS (role sync engine)' : `\nFAIL (${failures} checks)`)
    process.exitCode = failures === 0 ? 0 : 1
  } finally {
    db.removeLinkedRole(TEST_DROLE)
    db.removeLinkedRole(TEST_DROLE2)
    for (const id of [...TEST_USERS, 'test_sync_h_manual']) {
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
