'use strict'

// Dry run of /setup-log-channels with a mocked guild. Backs up config.yml,
// exercises the handler (channel creation, section aware config writing,
// reuse and keep paths), prints the reply, then restores config.yml.

process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'x'
process.env.DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID || '1'

const fs = require('fs')
const path = require('path')

const CONFIG = path.join(__dirname, '..', 'config.yml')
const BACKUP = CONFIG + '.testbak'
fs.copyFileSync(CONFIG, BACKUP)

const { handleInteraction } = require('../src/interactions')
const groupLogs = require('../src/groupLogs')

let nextId = 5000
const createdChannels = []

function makeGuild() {
  const channels = new Map()
  return {
    id: '1',
    roles: { everyone: { id: '1' } },
    channels: {
      cache: {
        get: (id) => channels.get(id),
        find: (fn) => [...channels.values()].find(fn),
      },
      create: async (opts) => {
        const ch = { id: String(nextId++), name: opts.name, type: opts.type, parentId: opts.parent }
        channels.set(ch.id, ch)
        createdChannels.push(`${ch.name} -> ${ch.id}`)
        return ch
      },
    },
  }
}

function mockInteraction(guild) {
  const replies = []
  return {
    replies,
    interaction: {
      user: { id: '42', tag: 'admin#0' },
      guild,
      client: {
        user: { id: 'botid' },
        channels: { cache: { get: () => undefined }, fetch: async () => null },
        isReady: () => true,
      },
      memberPermissions: { has: () => true },
      values: [],
      commandName: 'setup-log-channels',
      isAutocomplete: () => false,
      isButton: () => false,
      isStringSelectMenu: () => false,
      isChatInputCommand: () => true,
      isRepliable: () => true,
      options: {
        getChannel: () => ({ id: '9999', name: 'LOGS', type: 4 }),
        getString: () => null,
        getRole: () => null,
      },
      deferReply: async () => {},
      reply: async (p) => replies.push(p),
      editReply: async (p) => replies.push(p),
    },
  }
}

async function main() {
  try {
    const guild = makeGuild()

    // Round 1: everything empty, expect 10 channels created.
    let m = mockInteraction(guild)
    await handleInteraction(m.interaction)
    console.log('Round 1 created:', createdChannels.length, 'channels')
    console.log(createdChannels.join('\n'))
    const embed = m.replies[m.replies.length - 1]?.embeds?.[0]
    console.log('\nReply description:\n' + (embed?.description || '(none)'))

    // Round 2: same guild, everything filled and alive, expect all kept.
    createdChannels.length = 0
    m = mockInteraction(guild)
    await handleInteraction(m.interaction)
    const desc2 = m.replies[m.replies.length - 1]?.embeds?.[0]?.description || ''
    const kept = (desc2.match(/Kept/g) || []).length
    console.log(`\nRound 2: created ${createdChannels.length}, kept ${kept} (expect 0 created, 10 kept)`)

    const written = fs.readFileSync(CONFIG, 'utf8')
    const filled = (written.match(/_channel_id: "\d+"/g) || []).length
    console.log(`config.yml keys filled: ${filled} (expect 16)`)
    console.log(filled === 16 && createdChannels.length === 0 && kept === 10 ? '\nPASS' : '\nFAIL')
  } finally {
    groupLogs.stop()
    fs.copyFileSync(BACKUP, CONFIG)
    fs.unlinkSync(BACKUP)
    console.log('config.yml restored')
  }
}

main().catch((err) => {
  console.error('TEST ERROR:', err)
  fs.copyFileSync(BACKUP, CONFIG)
  process.exit(1)
})
