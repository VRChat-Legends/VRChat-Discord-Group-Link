'use strict'

// One-off end to end test for bio-or-status verification. Puts a test code
// in the bot account's own statusDescription (mangled formatting), runs the
// verify handler against it, then restores the original status.

process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'x'
process.env.DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID || '1'

const { getAuthCookies, throttledFetch, VRCHAT_API, UA } = require('../src/vrchatAuth')
const db = require('../src/db')
const { handleInteraction } = require('../src/interactions')

async function api(method, path, body) {
  const cookies = await getAuthCookies()
  const res = await throttledFetch(`${VRCHAT_API}${path}`, {
    method,
    headers: { Cookie: cookies, 'User-Agent': UA, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) throw new Error(`${method} ${path} -> HTTP ${res.status} ${await res.text().catch(() => '')}`)
  return res.json()
}

function mockVerify(userId) {
  const replies = []
  const interaction = {
    user: { id: userId, tag: 'tester#0', username: 'tester' },
    client: { user: { id: 'botid' } },
    customId: 'link_verify',
    values: [],
    isAutocomplete: () => false,
    isButton: () => true,
    isStringSelectMenu: () => false,
    isChatInputCommand: () => false,
    isRepliable: () => true,
    deferUpdate: async () => {},
    update: async (p) => replies.push(p),
    editReply: async (p) => replies.push(p),
    reply: async (p) => replies.push(p),
  }
  return { interaction, replies }
}

async function main() {
  const TESTER = '999000222'
  const me = await api('GET', '/auth/user')
  console.log(`Acting as ${me.displayName} (${me.id})`)
  const originalStatus = me.statusDescription || ''

  const code = 'VRCL-TQ7Z2M'
  db.deleteLink(TESTER)
  db.saveLinkCode(TESTER, { code, vrchatId: me.id, vrchatName: me.displayName, expiresAt: Date.now() + 600000 })

  try {
    // Mangled: lowercase, no dash, spaces inserted. Must still verify.
    await api('PUT', `/users/${me.id}`, { statusDescription: 'vrcl tq7 z2m' })
    console.log('Status set to mangled test code, waiting for API readback...')
    const check = await api('GET', `/users/${me.id}`)
    console.log('Readback statusDescription:', JSON.stringify(check.statusDescription))

    const { interaction, replies } = mockVerify(TESTER)
    await handleInteraction(interaction)
    const last = replies[replies.length - 1]
    const text = String(last?.content || '')
    console.log('\nVERIFY REPLY:', text.split('\n')[0])
    console.log(text.includes('Linked!') ? '\nPASS: mangled code in STATUS verified' : '\nFAIL: did not verify')
  } finally {
    await api('PUT', `/users/${me.id}`, { statusDescription: originalStatus })
    console.log('Status restored to:', JSON.stringify(originalStatus))
    db.deleteLink(TESTER)
    db.deleteLinkCode(TESTER)
  }
}

main().catch((err) => {
  console.error('TEST ERROR:', err.message)
  process.exit(1)
})
