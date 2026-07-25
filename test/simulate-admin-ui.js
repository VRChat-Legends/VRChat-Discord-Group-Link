'use strict'

// Offline exercise of the new admin UI routes: the VRChat action buttons on
// a group log post, the cancel path, the link panel button, and the right
// click profile lookup. Uses a seeded moderation log and mock interactions,
// so nothing is ever changed in VRChat.

process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'x'
process.env.DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID || '1'

const db = require('../src/db')
const { handleInteraction } = require('../src/interactions')

const LOG_ID = 'testlog' + Date.now().toString(16)
const results = []

function check(name, pass, detail = '') {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

function mock(overrides = {}) {
  const state = { replies: [], updates: [], modals: [] }
  const base = {
    user: { id: '999', tag: 'tester#0' },
    memberPermissions: { has: () => true },
    guild: { id: '1' },
    client: { user: { id: 'bot' } },
    isAutocomplete: () => false,
    isButton: () => false,
    isStringSelectMenu: () => false,
    isModalSubmit: () => false,
    isUserContextMenuCommand: () => false,
    isChatInputCommand: () => false,
    isRepliable: () => true,
    deferReply: async () => {},
    deferUpdate: async () => {},
    reply: async (p) => state.replies.push(p),
    editReply: async (p) => state.replies.push(p),
    update: async (p) => state.updates.push(p),
    showModal: async (m) => state.modals.push(m),
    message: { embeds: [], edit: async () => {} },
  }
  return { state, interaction: { ...base, ...overrides } }
}

async function main() {
  db.saveModerationLog({
    logId: LOG_ID,
    auditId: 'audit_test',
    eventType: 'group.instance.kick',
    targetId: 'usr_00000000-0000-0000-0000-000000000000',
    targetName: 'Test Target',
    actorName: 'Test Actor',
    location: 'wrld_test',
    occurredAt: new Date().toISOString(),
    channelId: '123',
    messageId: '456',
  })
  db.setModerationReason(LOG_ID, 'Trolling', '999')

  // 1. Ban button asks for confirmation and never touches VRChat.
  let m = mock({ isButton: () => true, customId: `mod_do:ban:${LOG_ID}` })
  await handleInteraction(m.interaction)
  const confirm = m.state.replies[0]
  const confirmButton = confirm?.components?.[0]?.components?.[0]
  check('mod_do shows a confirmation', Boolean(confirmButton) && confirmButton.custom_id === `mod_go:ban:${LOG_ID}`, confirmButton?.label)
  check('confirmation carries the stored reason', String(confirm?.content || '').includes('Trolling'))

  // 2. Non admins get nothing.
  m = mock({ isButton: () => true, customId: `mod_do:ban:${LOG_ID}`, memberPermissions: { has: () => false } })
  await handleInteraction(m.interaction)
  check('mod_do is admin gated', String(m.state.replies[0]?.content || '').includes('Administrator'))

  // 3. Cancel clears the controls.
  m = mock({ isButton: () => true, customId: 'mod_cancel' })
  await handleInteraction(m.interaction)
  check('cancel clears components', m.state.updates[0]?.components?.length === 0, m.state.updates[0]?.content)

  // 4. Link panel button opens the modal for an unlinked user.
  m = mock({ isButton: () => true, customId: 'link_panel_start', user: { id: 'unlinked-user', tag: 'nobody#0' } })
  await handleInteraction(m.interaction)
  const modal = m.state.modals[0]?.toJSON?.() || m.state.modals[0]
  check('link panel opens a modal', modal?.custom_id === 'link_panel_modal', modal?.title)

  // 5. Right click profile on someone with no link.
  m = mock({
    isUserContextMenuCommand: () => true,
    commandName: 'VRChat Profile',
    targetId: 'unlinked-user',
    targetUser: { id: 'unlinked-user' },
  })
  await handleInteraction(m.interaction)
  check('context menu handles unlinked users', String(m.state.replies[0] || '').includes('has not linked'))

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  process.exitCode = failed.length ? 1 : 0
}

main().catch((err) => {
  console.error('TEST ERROR:', err)
  process.exit(1)
})
