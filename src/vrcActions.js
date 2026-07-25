'use strict'

// VRChat moderation actions driven from Discord: ban, unban, and kick.
// One place so the slash commands and the log buttons behave identically,
// including permission checks, logging, and VRChat hierarchy refusals.

const config = require('./config')
const logger = require('./logger')
const db = require('./db')
const vrc = require('./vrchatApi')
const discordLog = require('./discordLog')

const log = logger('VRCActions')

const ACTIONS = {
  ban: {
    verb: 'banned',
    color: 0xe01b24,
    run: (userId) => vrc.banGroupMember(userId),
  },
  unban: {
    verb: 'unbanned',
    color: 0x33d17a,
    run: (userId) => vrc.unbanGroupMember(userId),
  },
  kick: {
    verb: 'kicked',
    color: 0xff8800,
    run: (userId) => vrc.kickGroupMember(userId),
  },
}

function friendlyError(err) {
  const msg = err?.vrchatMessage || err?.message || 'unknown error'
  if (err?.status === 403 || /same or higher rank|not allowed/i.test(msg)) {
    return [
      'VRChat refused it: I cannot act on this member.',
      'VRChat only lets an account moderate members **below** its own highest group role, and the role needs the matching group permission.',
      `VRChat said: ${msg}`,
    ].join('\n')
  }
  if (err?.status === 404 || /not found/i.test(msg)) return 'VRChat says that user is not in the group (or already gone).'
  return `VRChat refused it: ${msg}`
}

/**
 * Run a moderation action against a VRChat user.
 * Returns { ok, message, user } and never throws.
 */
async function runAction(action, userId, { reason = '', byTag = '', byDiscordId = '' } = {}) {
  const def = ACTIONS[action]
  if (!def) return { ok: false, message: `Unknown action: ${action}` }
  if (!config.moderation.allowActionsFromDiscord) {
    return { ok: false, message: 'VRChat actions from Discord are turned off in config.yml (moderation.allow_actions_from_discord).' }
  }

  let user = null
  try {
    user = await vrc.getUser(userId)
  } catch {
    /* keep going: the action still works with just the id */
  }
  const name = user?.displayName || userId

  try {
    await def.run(userId)
  } catch (err) {
    log.warn(`${action} failed for ${name}:`, err.message)
    return { ok: false, message: friendlyError(err), user }
  }

  log.info(`${def.verb} ${name} (${userId}) in the VRChat group, by ${byTag || 'unknown'}${reason ? ` for: ${reason}` : ''}`)

  const link = db.getLinkByVrchat(userId)
  discordLog.logAlert(
    `VRChat member ${def.verb}`,
    [
      `**${name}** (\`${userId}\`) was ${def.verb} in the VRChat group.`,
      link ? `Discord account: <@${link.discord_id}>` : null,
      reason ? `Reason: ${reason}` : null,
      byDiscordId ? `By: <@${byDiscordId}>` : null,
    ].filter(Boolean).join('\n')
  )

  return {
    ok: true,
    user,
    message: `**${name}** has been ${def.verb} in the VRChat group.${reason ? `\nReason: ${reason}` : ''}`,
  }
}

// ---------------------------------------------------------------
// case threads
// ---------------------------------------------------------------

function caseTemplate(record) {
  const heading = /ban/i.test(record.eventType) ? 'BAN'
    : /kick/i.test(record.eventType) ? 'KICK'
    : /warn/i.test(record.eventType) ? 'WARNING'
    : 'ACTION'
  return [
    '```',
    `ACTION: ${heading}`,
    `USER ID: ${record.targetId || ''}`,
    `REASON: ${record.reason || ''}`,
    'RULE VIOLATED:',
    `LOCATION (World/Instance): ${record.location || ''}`,
    `TIME (Local/UTC): ${record.occurredAt || ''}`,
    'EVIDENCE (clip/screenshot/witness):',
    `STAFF MEMBER: ${record.actorName || ''}`,
    'ESCALATED TO ADMIN: Yes/No',
    'NOTES:',
    '```',
  ].join('\n')
}

/**
 * Open a discussion thread on a moderation log message and seed it with
 * the staff template. Never throws; threads are a convenience.
 */
async function openCaseThread(message, record) {
  if (!config.moderation.caseThreads || !message?.startThread) return null
  const label = record.targetName || record.targetId || 'case'
  try {
    const thread = await message.startThread({
      name: `Case: ${String(label).slice(0, 80)}`,
      autoArchiveDuration: 4320,
      reason: 'VRChat moderation case',
    })
    await thread.send({
      content: `Case notes for **${label}**. Fill this in and attach evidence.\n${caseTemplate(record)}`,
      allowedMentions: { parse: [] },
    })
    return thread
  } catch (err) {
    log.warn('case thread failed:', err.message)
    return null
  }
}

module.exports = { runAction, openCaseThread, caseTemplate, friendlyError }
