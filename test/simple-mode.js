'use strict'

// Offline check: with simple_mode on, the bot registers only the log
// commands, group log messages carry no buttons, and everything that was
// switched off answers with the simple mode notice.

const config = require('../src/config')
config.simpleMode = true

const commands = require('../src/commands')
const groupLogs = require('../src/groupLogs')
const interactions = require('../src/interactions')

let pass = 0
let fail = 0

function check(name, ok, extra = '') {
  if (ok) {
    pass += 1
    console.log(`PASS  ${name}${extra ? `  (${extra})` : ''}`)
  } else {
    fail += 1
    console.log(`FAIL  ${name}${extra ? `  (${extra})` : ''}`)
  }
}

const SAMPLE = {
  id: 'gaud_test',
  eventType: 'group.member.ban',
  actorId: 'usr_actor',
  actorDisplayName: 'Some Staff',
  description: 'Some Staff banned Someone.',
  created_at: new Date().toISOString(),
  targetId: 'usr_target',
  data: {},
}

async function main() {
  const names = commands.buildCommands().map((c) => c.name)
  check('only log commands registered', !names.includes('link') && !names.includes('vrc-ban') && names.includes('help'), names.join(', '))

  const built = await groupLogs._buildEmbed(SAMPLE)
  check('group log has no buttons', !built.actionable && !built.components)
  check('group log has no ping content', !built.content)

  const replies = []
  const fakeCommand = {
    isAutocomplete: () => false,
    isChatInputCommand: () => true,
    isButton: () => false,
    isStringSelectMenu: () => false,
    isModalSubmit: () => false,
    isUserContextMenuCommand: () => false,
    commandName: 'link',
    reply: async (payload) => { replies.push(payload) },
  }
  await interactions.handleInteraction(fakeCommand)
  check('/link is refused', replies.length === 1 && /Simple mode is on/.test(replies[0].content || ''))

  const buttonReplies = []
  const fakeButton = {
    isAutocomplete: () => false,
    isChatInputCommand: () => false,
    isButton: () => true,
    customId: 'mod_do:ban:abc',
    reply: async (payload) => { buttonReplies.push(payload) },
  }
  await interactions.handleInteraction(fakeButton)
  check('old ban button is refused', buttonReplies.length === 1)

  const allowedReplies = []
  const fakeHelp = {
    isAutocomplete: () => false,
    isChatInputCommand: () => true,
    isButton: () => false,
    isStringSelectMenu: () => false,
    isModalSubmit: () => false,
    isUserContextMenuCommand: () => false,
    commandName: 'help',
    memberPermissions: { has: () => false },
    reply: async (payload) => { allowedReplies.push(payload) },
  }
  await interactions.handleInteraction(fakeHelp)
  check('/help still works', allowedReplies.length === 1 && /Simple mode is on/.test(allowedReplies[0].embeds?.[0]?.description || ''))

  console.log(`\n${pass}/${pass + fail} passed`)
  process.exit(fail ? 1 : 0)
}

main()
