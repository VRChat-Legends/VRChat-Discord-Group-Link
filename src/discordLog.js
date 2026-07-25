'use strict'

// Discord log channels: the bot narrates what it does into the channels
// configured in config.yml (logs section). Fire and forget; a broken or
// missing channel never breaks the action being logged.

const config = require('./config')
const logger = require('./logger')
const vrc = require('./vrchatApi')

const log = logger('DiscordLog')

const COLORS = {
  link: 0x2bcf5c,
  unlink: 0xff7b42,
  role: 0x8143e6,
  alert: 0xe01b24,
}

let clientRef = null

function init(client) {
  clientRef = client
}

async function send(channelId, embed) {
  if (!clientRef || !channelId) return
  try {
    const channel = clientRef.channels.cache.get(channelId)
      || await clientRef.channels.fetch(channelId).catch(() => null)
    if (!channel || !channel.isTextBased?.()) return
    await channel.send({ embeds: [embed], allowedMentions: { parse: [] } })
  } catch (err) {
    log.warn(`log post to ${channelId} failed:`, err.message)
  }
}

function now() {
  return `<t:${Math.floor(Date.now() / 1000)}:f>`
}

function profileImage(user) {
  return user?.profilePicOverride || user?.userIcon || user?.currentAvatarThumbnailImageUrl
    || user?.currentAvatarImageUrl || user?.thumbnailUrl || null
}

// vrchatUser is the full profile when we have it, so the log can show the
// avatar and the details staff care about at a glance.
function logLink(discordId, vrchatName, vrchatId, vrchatUser = null) {
  const fields = [
    { name: 'VRChat', value: `[${vrchatName}](https://vrchat.com/home/user/${vrchatId})`, inline: true },
    { name: 'User ID', value: `\`${vrchatId}\``, inline: true },
    { name: 'When', value: now(), inline: true },
  ]

  if (vrchatUser) {
    const joined = Date.parse(vrchatUser.date_joined || '')
    fields.push(
      { name: 'Trust rank', value: vrc.getTrustRank(vrchatUser).label, inline: true },
      { name: 'VRC+', value: vrc.hasVrcPlus(vrchatUser) ? 'Yes' : 'No', inline: true },
      { name: '18+ verified', value: vrc.isAgeVerified18Plus(vrchatUser) ? 'Yes' : 'No', inline: true },
      { name: 'Platform', value: vrchatUser.last_platform || 'unknown', inline: true },
      { name: 'VRChat since', value: Number.isFinite(joined) ? `<t:${Math.floor(joined / 1000)}:D>` : 'unknown', inline: true },
      { name: 'Pronouns', value: String(vrchatUser.pronouns || 'None').slice(0, 100), inline: true },
    )
  }

  const image = profileImage(vrchatUser)
  return send(config.logs.linkChannelId, {
    title: 'Account linked',
    color: COLORS.link,
    description: `<@${discordId}> linked to **${vrchatName}**`,
    thumbnail: image ? { url: image } : undefined,
    fields,
  })
}

function logUnlink(discordId, vrchatName, vrchatId = '', vrchatUser = null) {
  const image = profileImage(vrchatUser)
  return send(config.logs.linkChannelId, {
    title: 'Account unlinked',
    color: COLORS.unlink,
    description: `<@${discordId}> unlinked from **${vrchatName}**`,
    thumbnail: image ? { url: image } : undefined,
    fields: [
      vrchatId ? { name: 'User ID', value: `\`${vrchatId}\``, inline: true } : null,
      { name: 'When', value: now(), inline: true },
    ].filter(Boolean),
  })
}

function logRoleChange({ discordId, action, side, roleName, drivenBy }) {
  return send(config.logs.roleChannelId, {
    title: `Role ${action}`,
    color: COLORS.role,
    description: `<@${discordId}>: ${action} **${roleName}** on ${side}`,
    fields: [
      { name: 'Driven by', value: drivenBy, inline: true },
      { name: 'When', value: now(), inline: true },
    ],
  })
}

function logAlert(title, detail) {
  return send(config.logs.alertChannelId, {
    title: `Alert: ${title}`,
    color: COLORS.alert,
    description: String(detail || '').slice(0, 2000),
    fields: [{ name: 'When', value: now(), inline: true }],
  })
}

module.exports = { init, logLink, logUnlink, logRoleChange, logAlert }
