'use strict'

// Legends Alley role sync against a mocked guild and a mocked backend:
// planning, the 2 community case, switched off communities, deleted
// communities, renames, and keeping the role block tidy under the divider.
// Snapshots the alley_roles kv row and data/setup-backup.json and puts both
// back, so it never disturbs a live install.

process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'x'
process.env.DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID || '1'
process.env.ALLEY_BOT_KEY = 'test-key'

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const BACKUP_JSON = path.join(__dirname, '..', 'data', 'setup-backup.json')
const hadBackupJson = fs.existsSync(BACKUP_JSON)
const backupText = hadBackupJson ? fs.readFileSync(BACKUP_JSON, 'utf8') : null

const db = require('../src/db')
const alley = require('../src/alleyRoles')

const savedKv = db.getKv('alley_roles', null)
db.setKv('alley_roles', null)

/* ─── mock guild ─── */

let nextId = 9000

class Collection extends Map {
  find(fn) {
    for (const v of this.values()) if (fn(v)) return v
    return undefined
  }
}

function makeGuild(memberIds) {
  const roles = new Collection()
  const members = new Collection()
  const guild = { id: '1' }

  function reindex() {
    // keep positions unique and dense like discord does
    const list = [...roles.values()].sort((a, b) => a.position - b.position)
    list.forEach((r, i) => { r.position = i + 1 })
  }

  function makeRole(name, position, extra = {}) {
    const role = {
      id: String(nextId++), name, position, managed: false, editable: true, ...extra,
      get members() {
        const out = new Collection()
        for (const m of members.values()) if (m.roles.cache.has(role.id)) out.set(m.id, m)
        return out
      },
      async setName(value) { role.name = value; return role },
      async setPosition(value) {
        for (const r of roles.values()) if (r !== role && r.position >= value) r.position += 1
        role.position = value
        reindex()
        return role
      },
      async delete() { roles.delete(role.id); for (const m of members.values()) m.roles.cache.delete(role.id) },
    }
    roles.set(role.id, role)
    return role
  }

  // the bot's own role sits on top, an unrelated role in the middle
  const botRole = makeRole('Bot', 50, { editable: false })
  makeRole('Moderator', 40, { editable: false })

  for (const id of memberIds) {
    const cache = new Collection()
    const member = {
      id,
      roles: {
        cache,
        async add(role) { cache.set(role.id, role) },
        async remove(role) { cache.delete(role.id) },
      },
    }
    members.set(id, member)
  }

  guild.roles = {
    cache: roles,
    async create({ name }) {
      return makeRole(name, 0.5)
    },
    async setPositions(list) {
      for (const { role, position } of list) roles.get(role).position = position
      reindex()
    },
  }
  guild.members = {
    cache: members,
    me: { roles: { highest: botRole } },
    async fetch() { return members },
  }
  reindex()
  return guild
}

function client(guild) {
  return { guilds: { cache: new Map([['1', guild]]), fetch: async () => guild } }
}

let backendState = null
global.fetch = async (url, options) => {
  assert.ok(url.endsWith('/api/internal/roles/state'))
  assert.strictEqual(options.headers['x-bot-key'], 'test-key')
  return { ok: true, status: 200, json: async () => backendState }
}

function names(guild, memberId) {
  const member = guild.members.cache.get(memberId)
  return [...member.roles.cache.values()].map((r) => r.name).sort()
}

function block(guild) {
  return [...guild.roles.cache.values()].sort((a, b) => b.position - a.position).map((r) => r.name)
}

/* ─── run ─── */

async function main() {
  // planning: switched off communities grant nothing
  const planned = alley.plan({
    communities: [
      { id: 'a', name: 'Cubee', active: true, ownerDiscordId: '100', managerDiscordIds: ['101'], teamMembers: [{ name: 'x', discordId: '102' }, { name: 'nameonly', discordId: null }] },
      { id: 'b', name: 'Off One', active: false, ownerDiscordId: '100', teamMembers: [] },
    ],
  })
  assert.deepStrictEqual([...planned.generic.get('100')], ['owner'])
  assert.strictEqual(planned.community.get('b').members.size, 0)
  assert.strictEqual(planned.community.get('a').members.size, 3)

  const guild = makeGuild(['100', '101', '102', '103', '104'])
  // somebody holds Booth Owner by hand already; the sync should take it off
  const stale = await guild.roles.create({ name: 'Booth Owner' })
  await guild.members.cache.get('104').roles.add(stale)

  backendState = {
    communities: [
      // 100 owns Cubee and is on Jaws's team: the two community case
      { id: 'a', name: 'Cubee', active: true, ownerDiscordId: '100', managerDiscordIds: ['101'], teamMembers: [{ name: 'p', discordId: '102' }] },
      { id: 'b', name: 'Jaws', active: true, ownerDiscordId: '103', managerDiscordIds: [], teamMembers: [{ name: 'q', discordId: '100' }] },
      // 103 also owns a switched off one: it grants nothing
      { id: 'c', name: 'Asleep', active: false, ownerDiscordId: '103', teamMembers: [] },
    ],
    pending: [],
  }
  await alley.reconcile(client(guild), { full: true })

  assert.deepStrictEqual(names(guild, '100'), ['Booth Owner', 'Booth Team', 'Booth: Cubee', 'Booth: Jaws'])
  assert.deepStrictEqual(names(guild, '101'), ['Booth Manager', 'Booth: Cubee'])
  assert.deepStrictEqual(names(guild, '102'), ['Booth Team', 'Booth: Cubee'])
  assert.deepStrictEqual(names(guild, '103'), ['Booth Owner', 'Booth: Jaws'])
  assert.deepStrictEqual(names(guild, '104'), [], 'hand given managed role taken back')
  assert.ok(guild.roles.cache.find((r) => r.name === 'Booth: Asleep'), 'switched off community keeps its empty role')

  // tidy: divider right under the bot, the block in order, nothing else inside it
  assert.deepStrictEqual(block(guild), [
    'Bot', '──── Legends Alley ────', 'Booth Owner', 'Booth Manager', 'Booth Team',
    'Booth: Asleep', 'Booth: Cubee', 'Booth: Jaws', 'Moderator',
  ])

  // switch Cubee off, rename Jaws, delete Asleep, add a community
  backendState = {
    communities: [
      { id: 'a', name: 'Cubee', active: false, ownerDiscordId: '100', managerDiscordIds: ['101'], teamMembers: [{ name: 'p', discordId: '102' }] },
      { id: 'b', name: 'Jaws and Paws', active: true, ownerDiscordId: '103', managerDiscordIds: [], teamMembers: [{ name: 'q', discordId: '100' }] },
      { id: 'd', name: 'Alpha', active: true, ownerDiscordId: '104', teamMembers: [] },
    ],
    pending: ['a'],
  }
  await alley.reconcile(client(guild))

  assert.deepStrictEqual(names(guild, '100'), ['Booth Team', 'Booth: Jaws and Paws'], 'owner of a switched off community loses Owner')
  assert.deepStrictEqual(names(guild, '101'), [])
  assert.deepStrictEqual(names(guild, '102'), [])
  assert.deepStrictEqual(names(guild, '104'), ['Booth Owner', 'Booth: Alpha'])
  assert.ok(!guild.roles.cache.find((r) => r.name === 'Booth: Asleep'), 'deleted community role removed')
  assert.deepStrictEqual(block(guild), [
    'Bot', '──── Legends Alley ────', 'Booth Owner', 'Booth Manager', 'Booth Team',
    'Booth: Alpha', 'Booth: Cubee', 'Booth: Jaws and Paws', 'Moderator',
  ])

  // switching Cubee back on brings everyone back without new roles
  const before = guild.roles.cache.size
  backendState.communities[0].active = true
  await alley.reconcile(client(guild))
  assert.strictEqual(guild.roles.cache.size, before, 'no duplicate roles')
  assert.deepStrictEqual(names(guild, '100'), ['Booth Owner', 'Booth Team', 'Booth: Cubee', 'Booth: Jaws and Paws'])
  assert.deepStrictEqual(names(guild, '101'), ['Booth Manager', 'Booth: Cubee'])

  console.log('alley-roles: all checks passed')
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => {
    db.setKv('alley_roles', savedKv)
    if (hadBackupJson) fs.writeFileSync(BACKUP_JSON, backupText)
    else if (fs.existsSync(BACKUP_JSON)) fs.unlinkSync(BACKUP_JSON)
  })
