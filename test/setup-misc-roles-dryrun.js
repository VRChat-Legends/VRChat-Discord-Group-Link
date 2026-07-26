'use strict'

// Dry run of /setup-misc-roles with a mocked guild: create, adopt, restore
// from backup, and start fresh paths, plus the permission lock. Snapshots
// the real misc_roles table and data/setup-backup.json and restores both,
// so it never disturbs a live install.

process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'x'
process.env.DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID || '1'

const fs = require('fs')
const path = require('path')

const BACKUP_JSON = path.join(__dirname, '..', 'data', 'setup-backup.json')
const BACKUP_JSON_BAK = BACKUP_JSON + '.testbak'
const hadBackupJson = fs.existsSync(BACKUP_JSON)
if (hadBackupJson) fs.copyFileSync(BACKUP_JSON, BACKUP_JSON_BAK)

const db = require('../src/db')
const { handleInteraction, MISC_ROLE_DEFS } = require('../src/interactions')

const savedMiscRows = db.getMiscRoles()

function wipeMiscRoles() {
  db.getDb().exec('DELETE FROM misc_roles')
}

const EXPECT_ROLES = MISC_ROLE_DEFS.length

let nextId = 7000
const createdRoles = []
const deletedRoles = []

function makeGuild() {
  const roles = new Map()
  return {
    id: '1',
    _roles: roles,
    roles: {
      everyone: { id: '1' },
      cache: {
        get: (id) => roles.get(id),
        find: (fn) => [...roles.values()].find(fn),
      },
      create: async (opts) => {
        const role = {
          id: String(nextId++),
          name: opts.name,
          managed: false,
          delete: async () => {
            roles.delete(role.id)
            deletedRoles.push(role.id)
          },
        }
        roles.set(role.id, role)
        createdRoles.push(`${role.name} -> ${role.id}`)
        return role
      },
    },
  }
}

function baseInteraction(guild, replies) {
  return {
    user: { id: '42', tag: 'admin#0' },
    guild,
    client: { user: { id: 'botid' }, isReady: () => true },
    memberPermissions: { has: () => true },
    isAutocomplete: () => false,
    isButton: () => false,
    isStringSelectMenu: () => false,
    isModalSubmit: () => false,
    isUserContextMenuCommand: () => false,
    isChatInputCommand: () => false,
    isRepliable: () => true,
    deferReply: async () => {},
    deferUpdate: async () => {},
    reply: async (p) => replies.push(p),
    editReply: async (p) => replies.push(p),
    update: async (p) => replies.push(p),
  }
}

function mockCommand(guild) {
  const replies = []
  const interaction = {
    ...baseInteraction(guild, replies),
    commandName: 'setup-misc-roles',
    isChatInputCommand: () => true,
    options: { getChannel: () => null, getString: () => null, getRole: () => null },
  }
  return { replies, interaction }
}

function mockButton(guild, customId) {
  const replies = []
  const interaction = {
    ...baseInteraction(guild, replies),
    customId,
    isButton: () => true,
  }
  return { replies, interaction }
}

let failures = 0
function check(name, pass, detail = '') {
  if (!pass) failures++
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

async function main() {
  try {
    // Hermetic start: no db rows, no backup file.
    wipeMiscRoles()
    if (fs.existsSync(BACKUP_JSON)) fs.unlinkSync(BACKUP_JSON)

    const guild = makeGuild()

    // Round 1: nothing exists, expect every role created + backup written.
    let m = mockCommand(guild)
    await handleInteraction(m.interaction)
    check('round 1 creates every role', createdRoles.length === EXPECT_ROLES, `${createdRoles.length}/${EXPECT_ROLES}`)
    check('round 1 fills the database', Object.keys(db.getMiscRoles()).length === EXPECT_ROLES)
    check('round 1 writes the backup file', fs.existsSync(BACKUP_JSON))

    // Round 2: run again, everything alive, expect zero creations.
    createdRoles.length = 0
    m = mockCommand(guild)
    await handleInteraction(m.interaction)
    check('round 2 reuses everything', createdRoles.length === 0, `created ${createdRoles.length}`)

    // Round 3: database wiped but backup + roles alive: expect the restore
    // prompt, then restore reconnects the same role ids with no creations.
    const idsBefore = JSON.stringify(db.getMiscRoles())
    wipeMiscRoles()
    m = mockCommand(guild)
    await handleInteraction(m.interaction)
    const prompt = m.replies[m.replies.length - 1]
    const promptIds = (prompt?.components?.[0]?.components || []).map((c) => c.data?.custom_id || c.custom_id).join(',')
    check('round 3 offers restore/fresh/cancel', promptIds.includes('setupmisc:restore') && promptIds.includes('setupmisc:fresh'), promptIds)

    createdRoles.length = 0
    m = mockButton(guild, 'setupmisc:restore')
    await handleInteraction(m.interaction)
    check('restore creates nothing', createdRoles.length === 0, `created ${createdRoles.length}`)
    check('restore reconnects the old role ids', JSON.stringify(db.getMiscRoles()) === idsBefore)

    // Round 4: wipe db again, pick Start fresh: old roles deleted from the
    // guild, a full new set created, db and backup point at the new ids.
    wipeMiscRoles()
    m = mockCommand(guild)
    await handleInteraction(m.interaction)
    createdRoles.length = 0
    m = mockButton(guild, 'setupmisc:fresh')
    await handleInteraction(m.interaction)
    check('fresh deletes the old roles', deletedRoles.length === EXPECT_ROLES, `deleted ${deletedRoles.length}`)
    check('fresh creates a full new set', createdRoles.length === EXPECT_ROLES, `created ${createdRoles.length}`)
    check('fresh points the db at new ids', Object.keys(db.getMiscRoles()).length === EXPECT_ROLES && JSON.stringify(db.getMiscRoles()) !== idsBefore)

    // Round 5: command and buttons are locked to the configured moderators.
    m = mockCommand(guild)
    m.interaction.memberPermissions = { has: () => false }
    await handleInteraction(m.interaction)
    check('command is permission locked', String(m.replies[0]?.content || '').includes('Administrator'), m.replies[0]?.content)

    m = mockButton(guild, 'setupmisc:fresh')
    m.interaction.memberPermissions = { has: () => false }
    await handleInteraction(m.interaction)
    check('buttons are permission locked', String(m.replies[0]?.content || '').includes('Administrator'), m.replies[0]?.content)

    console.log(failures === 0 ? '\nPASS (all rounds)' : `\nFAIL (${failures} checks)`)
    process.exitCode = failures === 0 ? 0 : 1
  } finally {
    // Put the real data back.
    wipeMiscRoles()
    for (const [key, id] of Object.entries(savedMiscRows)) db.setMiscRole(key, id)
    if (hadBackupJson) {
      fs.copyFileSync(BACKUP_JSON_BAK, BACKUP_JSON)
      fs.unlinkSync(BACKUP_JSON_BAK)
    } else if (fs.existsSync(BACKUP_JSON)) {
      fs.unlinkSync(BACKUP_JSON)
    }
    console.log('misc_roles table and setup-backup.json restored')
  }
}

main().catch((err) => {
  console.error('TEST ERROR:', err)
  process.exit(1)
})
