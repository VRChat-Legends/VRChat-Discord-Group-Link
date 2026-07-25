'use strict'

// VRChat-Discord Group Link: entry point.
// Discord client, command registration, event wiring, and the sync loop.

const { Client, Events, GatewayIntentBits } = require('discord.js')
const config = require('./config')
const logger = require('./logger')
const { logStartup } = require('./logger')
const db = require('./db')
const commands = require('./commands')
const interactions = require('./interactions')
const sync = require('./sync')
const discordLog = require('./discordLog')
const groupLogs = require('./groupLogs')
const feeds = require('./feeds')

const log = logger('Bot')

// Rich presence: always Online, rotating through config.yml entries.
const ACTIVITY_TYPES = { playing: 0, listening: 2, watching: 3, custom: 4, competing: 5 }
const PRESENCE_ROTATE_MS = 5 * 60 * 1000
let presenceIndex = 0

function applyPresence(client) {
  if (!client?.isReady()) return
  const entry = config.presence[presenceIndex % config.presence.length]
  presenceIndex += 1
  const type = ACTIVITY_TYPES[entry.type] ?? 4
  try {
    const activity = type === 4
      ? { type: 4, name: 'status', state: entry.text }
      : { type, name: entry.text }
    client.user.setPresence({ status: 'online', activities: [activity] })
  } catch {
    /* presence is cosmetic */
  }
}

function startPresenceLoop(client) {
  applyPresence(client)
  const timer = setInterval(() => applyPresence(client), PRESENCE_ROTATE_MS)
  timer.unref?.()
}

function main() {
  logStartup()

  const missing = config.validate()
  if (missing.length) {
    log.error(`Missing required configuration: ${missing.join(', ')}`)
    log.error('Copy .env.example to .env and fill in the values, then start again.')
    process.exit(1)
  }

  // Open the database early so schema problems surface before login.
  db.getDb()

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
    ],
  })

  client.once(Events.ClientReady, async (ready) => {
    log.info(`Gateway ready as ${ready.user.tag}`)

    try {
      await commands.registerCommands(ready.application.id)
    } catch (err) {
      log.error('Slash command registration failed:', err.message)
    }

    discordLog.init(client)
    startPresenceLoop(client)

    sync.startLoop(client)
    groupLogs.start(client)
    feeds.start(client)
  })

  client.on(Events.InteractionCreate, (interaction) => {
    interactions.handleInteraction(interaction).catch(async (err) => {
      log.error('Interaction failed:', err?.stack || err?.message || err)
      const message = { content: 'Something went wrong on my end. Try again in a moment.' }
      try {
        if (interaction.deferred || interaction.replied) await interaction.editReply(message)
        else if (interaction.isRepliable()) await interaction.reply({ ...message, flags: 64 })
      } catch {
        /* interaction already gone */
      }
    })
  })

  // Fast path: mirror Discord role changes to VRChat as they happen.
  client.on(Events.GuildMemberUpdate, (oldMember, newMember) => {
    if (newMember.guild.id !== config.discord.guildId) return
    sync.onMemberUpdate(oldMember, newMember).catch((err) =>
      log.warn('member update sync failed:', err.message)
    )
  })

  client.on(Events.Error, (err) => log.error('Client error:', err.message))

  process.on('unhandledRejection', (err) => {
    log.error('Unhandled rejection:', err?.stack || err?.message || err)
  })

  client.login(config.discord.token).catch((err) => {
    log.error('Discord login failed:', err.message)
    process.exit(1)
  })
}

main()
