'use strict'

// Prints the new moderation-style embed built from a real audit entry.
const vrc = require('../src/vrchatApi')
const g = require('../src/groupLogs')

async function main() {
  const start = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString()
  const data = await vrc.getGroupAuditLogs({ startDate: start, n: 100 })
  const pick = data.results.find((e) => /kick|warn|ban/.test(e.eventType)) || data.results[0]
  if (!pick) {
    console.log('No audit entries in window')
    return
  }
  const b = g._buildEmbed(pick)
  console.log('EMBED:', JSON.stringify(b.embed, null, 1))
  console.log('actionable:', b.actionable)
  console.log('components rows:', (b.components || []).length)
  if (b.components) {
    console.log('menu options:', b.components[0].components[0].options.length)
    console.log('buttons:', b.components[1].components.map((c) => c.label).join(', '))
  }
}

main().catch((err) => {
  console.error('ERR', err.message)
  process.exit(1)
})
