'use strict'

// Dry run of /setup-log-channels with a mocked guild. Backs up config.yml
// and data/setup-backup.json, exercises the handler (channel creation,
// section aware config writing, reuse and keep paths, restore from backup,
// start fresh), prints the results, then restores both files.

process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'x'
process.env.DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID || '1'

const fs = require('fs')
const path = require('path')

const CONFIG = path.join(__dirname, '..', 'config.yml')
const CONFIG_BAK = CONFIG + '.testbak'
const BACKUP_JSON = path.join(__dirname, '..', 'data', 'setup-backup.json')
const BACKUP_JSON_BAK = BACKUP_JSON + '.testbak'
fs.copyFileSync(CONFIG, CONFIG_BAK)
const hadBackupJson = fs.existsSync(BACKUP_JSON)
if (hadBackupJson) fs.copyFileSync(BACKUP_JSON, BACKUP_JSON_BAK)

const { handleInteraction } = require('../src/interactions')
const config = require('../src/config')
const groupLogs = require('../src/groupLogs')
const feeds = require('../src/feeds')

// The handler kicks the live feeds once channels exist. Not wanted in a
// dry run: it would burn API calls and move the real audit watermark.
groupLogs.start = () => {}
feeds.start = () => {}

const EXPECT_CHANNELS = 12
const EXPECT_KEYS = 18
const CATEGORY_ID = '9999'

// Every config key the setup fills, used to blank the config between rounds.
const ALL_KEYS = [
  { section: 'logs', key: 'link_channel_id' },
  { section: 'logs', key: 'role_channel_id' },
  { section: 'logs', key: 'alert_channel_id' },
  ...['default', 'warn', 'kick', 'ban', 'unban', 'join', 'leave', 'join_request', 'invite', 'role', 'post', 'instance', 'group']
    .map((cat) => ({ section: 'group_logs', key: `${cat}_channel_id` })),
  { section: 'feeds', key: 'posts_channel_id' },
  { section: 'feeds', key: 'join_requests_channel_id' },
]

function blankConfig() {
  config.writeChannelIds(ALL_KEYS.map((k) => ({ ...k, id: '' })))
}

let nextId = 5000
const createdChannels = []
const deletedChannels = []

function makeGuild() {
  const channels = new Map()
  channels.set(CATEGORY_ID, { id: CATEGORY_ID, name: 'LOGS', type: 4 })
  return {
    id: '1',
    roles: { everyone: { id: '1' } },
    _channels: channels,
    channels: {
      cache: {
        get: (id) => channels.get(id),
        find: (fn) => [...channels.values()].find(fn),
      },
      create: async (opts) => {
        const ch = {
          id: String(nextId++),
          name: opts.name,
          type: opts.type,
          parentId: opts.parent,
          delete: async () => {
            channels.delete(ch.id)
            deletedChannels.push(ch.id)
          },
        }
        channels.set(ch.id, ch)
        createdChannels.push(`${ch.name} -> ${ch.id}`)
        return ch
      },
    },
  }
}

function baseInteraction(guild, replies) {
  return {
    user: { id: '42', tag: 'admin#0' },
    guild,
    client: {
      user: { id: 'botid' },
      channels: { cache: { get: () => undefined }, fetch: async () => null },
      isReady: () => true,
    },
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
    commandName: 'setup-log-channels',
    isChatInputCommand: () => true,
    options: {
      getChannel: () => guild._channels.get(CATEGORY_ID),
      getString: () => null,
      getRole: () => null,
    },
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

function filledIds() {
  const written = fs.readFileSync(CONFIG, 'utf8')
  return (written.match(/_channel_id: "\d+"/g) || [])
}

let failures = 0
function check(name, pass, detail = '') {
  if (!pass) failures++
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

async function main() {
  try {
    // Hermetic start: no channel ids, no backup file.
    blankConfig()
    if (fs.existsSync(BACKUP_JSON)) fs.unlinkSync(BACKUP_JSON)

    const guild = makeGuild()

    // Round 1: everything empty, expect a channel per plan row.
    let m = mockCommand(guild)
    await handleInteraction(m.interaction)
    check('round 1 creates every channel', createdChannels.length === EXPECT_CHANNELS, `${createdChannels.length}/${EXPECT_CHANNELS}`)
    check('round 1 fills every config key', filledIds().length === EXPECT_KEYS, `${filledIds().length}/${EXPECT_KEYS}`)
    check('round 1 writes the backup file', fs.existsSync(BACKUP_JSON))

    // Round 2: same guild, everything filled and alive, expect all kept.
    createdChannels.length = 0
    m = mockCommand(guild)
    await handleInteraction(m.interaction)
    const desc2 = m.replies[m.replies.length - 1]?.embeds?.[0]?.description || ''
    const kept = (desc2.match(/Kept/g) || []).length
    check('round 2 keeps everything', createdChannels.length === 0 && kept === EXPECT_CHANNELS, `created ${createdChannels.length}, kept ${kept}`)

    // Round 3: config wiped but backup + channels alive: expect the
    // restore prompt, then restore reconnects without creating anything.
    const idsBefore = filledIds().join('|')
    blankConfig()
    m = mockCommand(guild)
    await handleInteraction(m.interaction)
    const prompt = m.replies[m.replies.length - 1]
    const promptIds = (prompt?.components?.[0]?.components || []).map((c) => c.data?.custom_id || c.custom_id).join(',')
    check('round 3 offers restore/fresh/cancel', promptIds.includes('setuplog:restore') && promptIds.includes('setuplog:fresh'), promptIds)

    createdChannels.length = 0
    m = mockButton(guild, `setuplog:restore:${CATEGORY_ID}`)
    await handleInteraction(m.interaction)
    check('restore creates nothing', createdChannels.length === 0, `created ${createdChannels.length}`)
    check('restore refills every key with the old ids', filledIds().join('|') === idsBefore)

    // Round 4: wipe config again, pick Start fresh: old channels deleted,
    // a full new set created, config filled with the new ids.
    blankConfig()
    m = mockCommand(guild)
    await handleInteraction(m.interaction)
    createdChannels.length = 0
    m = mockButton(guild, `setuplog:fresh:${CATEGORY_ID}`)
    await handleInteraction(m.interaction)
    check('fresh deletes the old channels', deletedChannels.length === EXPECT_CHANNELS, `deleted ${deletedChannels.length}`)
    check('fresh creates a full new set', createdChannels.length === EXPECT_CHANNELS, `created ${createdChannels.length}`)
    check('fresh fills every key with new ids', filledIds().length === EXPECT_KEYS && filledIds().join('|') !== idsBefore, `${filledIds().length} keys`)

    // Round 5: buttons are locked to the configured moderators.
    m = mockButton(guild, `setuplog:fresh:${CATEGORY_ID}`)
    m.interaction.memberPermissions = { has: () => false }
    await handleInteraction(m.interaction)
    check('buttons are permission locked', String(m.replies[0]?.content || '').includes('Administrator'), m.replies[0]?.content)

    console.log(failures === 0 ? '\nPASS (all rounds)' : `\nFAIL (${failures} checks)`)
    process.exitCode = failures === 0 ? 0 : 1
  } finally {
    groupLogs.stop()
    feeds.stop()
    fs.copyFileSync(CONFIG_BAK, CONFIG)
    fs.unlinkSync(CONFIG_BAK)
    if (hadBackupJson) {
      fs.copyFileSync(BACKUP_JSON_BAK, BACKUP_JSON)
      fs.unlinkSync(BACKUP_JSON_BAK)
    } else if (fs.existsSync(BACKUP_JSON)) {
      fs.unlinkSync(BACKUP_JSON)
    }
    console.log('config.yml and setup-backup.json restored')
  }
}

main().catch((err) => {
  console.error('TEST ERROR:', err)
  fs.copyFileSync(CONFIG_BAK, CONFIG)
  if (hadBackupJson) fs.copyFileSync(BACKUP_JSON_BAK, BACKUP_JSON)
  process.exit(1)
})
