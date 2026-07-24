'use strict'

// Offline simulation of the /link flow with mock interaction objects and
// the real VRChat API. Run: node test/simulate-link.js

process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'x'
process.env.DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID || '1'

const { handleInteraction } = require('../src/interactions')
const db = require('../src/db')

function mockInteraction({ command, options = {}, customId = null, values = [], userId = '999000111' }) {
  const replies = []
  const base = {
    user: { id: userId, tag: 'tester#0', username: 'tester' },
    memberPermissions: { has: () => true },
    client: { user: { id: 'botid' }, ws: { ping: 1 }, guilds: { fetch: async () => { throw new Error('no guild in sim') } } },
    guild: null,
    replied: false,
    deferred: false,
    values,
    isAutocomplete: () => false,
    isButton: () => Boolean(customId) && !values.length,
    isStringSelectMenu: () => Boolean(customId) && values.length > 0,
    isChatInputCommand: () => Boolean(command),
    isRepliable: () => true,
    customId,
    commandName: command,
    options: {
      getString: (name) => options[name] ?? null,
      getRole: (name) => options[name] ?? null,
      getFocused: () => '',
    },
    reply: async (payload) => { replies.push(['reply', payload]); base.replied = true },
    deferReply: async () => { base.deferred = true },
    deferUpdate: async () => { base.deferred = true },
    editReply: async (payload) => { replies.push(['editReply', payload]) },
    update: async (payload) => { replies.push(['update', payload]) },
  }
  return { interaction: base, replies }
}

function show(label, replies) {
  console.log(`\n=== ${label} ===`)
  for (const [kind, payload] of replies) {
    const text = typeof payload === 'string' ? payload : payload.content || JSON.stringify(payload).slice(0, 300)
    console.log(`[${kind}]`, String(text).slice(0, 500))
  }
}

async function main() {
  db.deleteLink('999000111')
  db.deleteLinkCode('999000111')

  // 1. /link with an exact VRChat name: straight to the code
  let m = mockInteraction({ command: 'link', options: { vrchat_user: 'VRChat Legends' } })
  await handleInteraction(m.interaction)
  show('/link (exact name)', m.replies)

  // 2. /link again while pending: should show the same code
  m = mockInteraction({ command: 'link', options: { vrchat_user: 'whatever' } })
  await handleInteraction(m.interaction)
  show('/link (pending)', m.replies)

  // 3. verify button without the code in bio: should say not found yet
  m = mockInteraction({ customId: 'link_verify' })
  await handleInteraction(m.interaction)
  show('verify (code not in bio)', m.replies)

  // 4. cancel
  m = mockInteraction({ customId: 'link_cancel' })
  await handleInteraction(m.interaction)
  show('cancel', m.replies)

  // 5. /link with a fuzzy name (no space): should get the account picker
  m = mockInteraction({ command: 'link', options: { vrchat_user: 'VRChatLegends' } })
  await handleInteraction(m.interaction)
  show('/link (fuzzy name, expects picker)', m.replies)

  // 6. picking an account from the menu issues the code
  m = mockInteraction({ customId: 'link_pick', values: ['usr_be67aefc-86dd-49c2-98e3-57a062e64bed'] })
  await handleInteraction(m.interaction)
  show('picker selection', m.replies)

  // 7. /link with pure garbage: no results message
  db.deleteLinkCode('999000111')
  m = mockInteraction({ command: 'link', options: { vrchat_user: 'zzqqxx no such person 9847' } })
  await handleInteraction(m.interaction)
  show('/link (garbage)', m.replies)

  db.deleteLink('999000111')
  db.deleteLinkCode('999000111')
  console.log('\nSimulation complete.')
}

main().catch((err) => {
  console.error('SIMULATION CRASH:', err.stack || err.message)
  process.exit(1)
})
