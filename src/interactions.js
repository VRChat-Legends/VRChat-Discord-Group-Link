'use strict'

// Interaction handling: slash commands, the vrchat_role autocomplete, and
// the link verification buttons.

const crypto = require('crypto')
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
} = require('discord.js')
const config = require('./config')
const db = require('./db')
const logger = require('./logger')
const vrc = require('./vrchatApi')
const sync = require('./sync')
const discordLog = require('./discordLog')

const log = logger('Interactions')

const EMBED_COLOR = 0x8143e6

function isAdmin(interaction) {
  return Boolean(
    interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
    || interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)
  )
}

// Codes read well in a bio and cannot be mistyped: VRCL-XXXXXX.
function generateCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let out = ''
  for (const byte of crypto.randomBytes(6)) out += alphabet[byte % alphabet.length]
  return `VRCL-${out}`
}

function discordTime(ms, style = 'R') {
  if (!Number.isFinite(ms)) return 'unknown'
  return `<t:${Math.floor(ms / 1000)}:${style}>`
}

// ---------------------------------------------------------------
// /link
// ---------------------------------------------------------------

function linkButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('link_verify').setLabel('I added it, verify now').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('link_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  )
}

function codeInstructions(code, vrchatName, expiresAt) {
  return [
    `Linking to VRChat user: **${vrchatName}**`,
    '',
    `1. Open your VRChat profile (vrchat.com or the app)`,
    `2. Add this code anywhere in your **bio**: \`${code}\``,
    `3. Save your bio, then press **I added it, verify now**`,
    '',
    `The code expires ${discordTime(expiresAt)}. You can remove it from your bio after verification.`,
  ].join('\n')
}

// Issue a fresh code for a confirmed VRChat user and show the instructions.
async function issueCode(interaction, user, { viaUpdate = false } = {}) {
  const taken = db.getLinkByVrchat(user.id)
  if (taken && taken.discord_id !== interaction.user.id) {
    const payload = { content: `**${user.displayName}** is already linked to another Discord account. If that is wrong, ask an admin.`, components: [] }
    if (viaUpdate) await interaction.editReply(payload)
    else await interaction.editReply(payload)
    return
  }

  const code = generateCode()
  const expiresAt = Date.now() + config.link.codeTtlMinutes * 60 * 1000
  db.saveLinkCode(interaction.user.id, { code, vrchatId: user.id, vrchatName: user.displayName, expiresAt })
  log.info(`/link code issued for ${interaction.user.tag} -> ${user.displayName} (${user.id})`)

  await interaction.editReply({
    content: codeInstructions(code, user.displayName, expiresAt),
    components: [linkButtons()],
  })
}

async function handleLink(interaction) {
  const existing = db.getLinkByDiscord(interaction.user.id)
  if (existing) {
    await interaction.reply({
      content: `You are already linked to **${existing.vrchat_name || existing.vrchat_id}**. Run /unlink first if you want to link a different VRChat account.`,
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  // A code is already pending: show it again instead of minting another.
  const pending = db.getLinkCode(interaction.user.id)
  if (pending) {
    await interaction.reply({
      content: codeInstructions(pending.code, pending.vrchat_name || pending.vrchat_id, pending.expires_at),
      components: [linkButtons()],
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral })

  const query = interaction.options.getString('vrchat_user', true).trim()

  // Direct usr_ id: no ambiguity.
  if (/^usr_[0-9a-f-]{36}$/i.test(query)) {
    let user
    try {
      user = await vrc.getUser(query)
    } catch (err) {
      log.error('/link user lookup failed:', err.message)
      await interaction.editReply('VRChat lookup failed. Try again in a minute.')
      return
    }
    if (!user) {
      await interaction.editReply(`No VRChat user found for \`${query}\`.`)
      return
    }
    await issueCode(interaction, user)
    return
  }

  // Name search: VRChat search is fuzzy, so never silently pick a random
  // match. Exact display name match proceeds; anything else gets a picker.
  let matches = []
  try {
    matches = await vrc.searchUsers(query, 10)
  } catch (err) {
    log.error('/link search failed:', err.message)
    await interaction.editReply('VRChat lookup failed. Try again in a minute.')
    return
  }

  if (!matches.length) {
    await interaction.editReply(
      `No VRChat user found for **${query}**. Use your exact display name (spaces matter) or your usr_ ID from your profile URL.`
    )
    return
  }

  const exact = matches.filter((u) => String(u.displayName || '').toLowerCase() === query.toLowerCase())
  if (exact.length === 1) {
    let user
    try {
      user = await vrc.getUser(exact[0].id)
    } catch {
      user = exact[0]
    }
    await issueCode(interaction, user)
    return
  }

  // Multiple or fuzzy matches: let them pick their own account.
  const menu = new StringSelectMenuBuilder()
    .setCustomId('link_pick')
    .setPlaceholder('Pick your VRChat account')
    .addOptions(matches.slice(0, 25).map((u) => ({
      label: String(u.displayName || u.id).slice(0, 100),
      description: String(u.statusDescription || u.id).slice(0, 100),
      value: u.id,
    })))
  await interaction.editReply({
    content: `I found **${matches.length}** VRChat account${matches.length === 1 ? '' : 's'} matching **${query}**. Pick yours:`,
    components: [new ActionRowBuilder().addComponents(menu)],
  })
}

async function handleLinkPick(interaction) {
  await interaction.deferUpdate()
  const vrchatId = interaction.values?.[0]
  let user
  try {
    user = await vrc.getUser(vrchatId)
  } catch (err) {
    log.error('link pick lookup failed:', err.message)
    await interaction.editReply({ content: 'VRChat lookup failed. Run /link again.', components: [] })
    return
  }
  if (!user) {
    await interaction.editReply({ content: 'That account no longer exists. Run /link again.', components: [] })
    return
  }
  await issueCode(interaction, user, { viaUpdate: true })
}

async function handleLinkVerify(interaction) {
  const pending = db.getLinkCode(interaction.user.id)
  if (!pending) {
    await interaction.update({
      content: 'That code has expired. Run /link again to get a new one.',
      components: [],
    })
    return
  }

  await interaction.deferUpdate()

  let user
  try {
    user = await vrc.getUser(pending.vrchat_id)
  } catch (err) {
    log.error('link verify lookup failed:', err.message)
    await interaction.editReply({ content: 'VRChat lookup failed. Wait a moment and press the button again.', components: [linkButtons()] })
    return
  }

  const bio = String(user?.bio || '')
  if (!bio.toUpperCase().includes(pending.code.toUpperCase())) {
    await interaction.editReply({
      content: `${codeInstructions(pending.code, pending.vrchat_name || pending.vrchat_id, pending.expires_at)}\n\nI do not see the code in your bio yet. VRChat can take a minute to save; try again shortly.`,
      components: [linkButtons()],
    })
    return
  }

  db.deleteLinkCode(interaction.user.id)
  db.createLink(interaction.user.id, user.id, user.displayName)
  log.info(`Linked ${interaction.user.tag} <-> ${user.displayName} (${user.id})`)
  discordLog.logLink(interaction.user.id, user.displayName, user.id)

  await interaction.editReply({
    content: `Linked! **${interaction.user.username}** is now connected to **${user.displayName}**. You can remove the code from your bio. Your roles will sync within a minute.`,
    components: [],
  })

  // Kick off an immediate sync for just this user so roles land right away.
  sync.syncOneUser(interaction.client, interaction.user.id).catch((err) =>
    log.warn('post-link sync failed:', err.message)
  )
}

async function handleLinkCancel(interaction) {
  db.deleteLinkCode(interaction.user.id)
  await interaction.update({ content: 'Link canceled. Run /link whenever you are ready.', components: [] })
}

// ---------------------------------------------------------------
// /unlink
// ---------------------------------------------------------------

async function handleUnlink(interaction) {
  const existing = db.getLinkByDiscord(interaction.user.id)
  if (!existing) {
    await interaction.reply({ content: 'You are not linked to any VRChat account.', flags: MessageFlags.Ephemeral })
    return
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral })

  // Take the bot-managed misc roles away on unlink; linked role pairs stop
  // being managed for this user from now on.
  try {
    await sync.removeMiscRoles(interaction.client, interaction.user.id)
  } catch (err) {
    log.warn('unlink misc role cleanup failed:', err.message)
  }

  db.deleteLink(interaction.user.id)
  db.deleteLinkCode(interaction.user.id)
  log.info(`Unlinked ${interaction.user.tag} from ${existing.vrchat_name || existing.vrchat_id}`)
  discordLog.logUnlink(interaction.user.id, existing.vrchat_name || existing.vrchat_id)
  await interaction.editReply(`Unlinked from **${existing.vrchat_name || existing.vrchat_id}**.`)
}

// ---------------------------------------------------------------
// linked roles (admin)
// ---------------------------------------------------------------

async function handleSetLinkedRole(interaction) {
  if (!isAdmin(interaction)) {
    await interaction.reply({ content: 'Administrator permission required.', flags: MessageFlags.Ephemeral })
    return
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral })

  const role = interaction.options.getRole('discord_role', true)
  const vrchatRoleId = interaction.options.getString('vrchat_role', true)

  const roles = await vrc.getGroupRoles()
  const vrchatRole = roles.find((r) => r.id === vrchatRoleId)
    || roles.find((r) => String(r.name || '').toLowerCase() === vrchatRoleId.toLowerCase())
  if (!vrchatRole) {
    await interaction.editReply('That VRChat group role was not found. Pick one from the autocomplete list.')
    return
  }

  // Refuse roles the bot cannot hand out.
  if (vrchatRole.isManagementRole) {
    await interaction.editReply(`**${vrchatRole.name}** is a management role; VRChat does not allow assigning it via the API.`)
    return
  }
  const me = interaction.guild.members.me
  if (role.managed || role.position >= me.roles.highest.position) {
    await interaction.editReply(`I cannot manage **${role.name}**. Move my bot role above it, and do not use bot-managed roles.`)
    return
  }

  db.setLinkedRole(role.id, role.name, vrchatRole.id, vrchatRole.name)
  log.info(`Linked role pair: @${role.name} <-> ${vrchatRole.name}`)
  await interaction.editReply(`Linked **@${role.name}** to VRChat group role **${vrchatRole.name}**. Members with either side get the other within a sync cycle.`)
}

async function handleRemoveLinkedRole(interaction) {
  if (!isAdmin(interaction)) {
    await interaction.reply({ content: 'Administrator permission required.', flags: MessageFlags.Ephemeral })
    return
  }
  const role = interaction.options.getRole('discord_role', true)
  const removed = db.removeLinkedRole(role.id)
  await interaction.reply({
    content: removed
      ? `Removed the link on **@${role.name}**. Existing roles stay as they are; they just stop syncing.`
      : `**@${role.name}** is not linked to any VRChat role.`,
    flags: MessageFlags.Ephemeral,
  })
}

async function handleListLinkedRoles(interaction) {
  if (!isAdmin(interaction)) {
    await interaction.reply({ content: 'Administrator permission required.', flags: MessageFlags.Ephemeral })
    return
  }
  const pairs = db.listLinkedRoles()
  if (!pairs.length) {
    await interaction.reply({ content: 'No linked roles yet. Use /set-linked-role to create one.', flags: MessageFlags.Ephemeral })
    return
  }
  const lines = pairs.map((p) => `<@&${p.discord_role_id}> -> **${p.vrchat_role_name || p.vrchat_role_id}**`)
  await interaction.reply({
    embeds: [{
      title: 'Linked roles',
      description: lines.join('\n'),
      color: EMBED_COLOR,
      footer: { text: `${pairs.length} pair${pairs.length === 1 ? '' : 's'} | two way sync every ${config.sync.intervalSeconds}s` },
    }],
    flags: MessageFlags.Ephemeral,
  })
}

async function handleVrchatRoleAutocomplete(interaction) {
  const focused = String(interaction.options.getFocused() || '').toLowerCase()
  let roles = []
  try {
    roles = await sync.getCachedGroupRoles()
  } catch {
    /* offer nothing on API failure */
  }
  const choices = roles
    .filter((r) => !r.isManagementRole)
    .filter((r) => !focused || String(r.name || '').toLowerCase().includes(focused))
    .slice(0, 25)
    .map((r) => ({ name: r.name, value: r.id }))
  await interaction.respond(choices).catch(() => {})
}

// ---------------------------------------------------------------
// /track
// ---------------------------------------------------------------

async function handleTrack(interaction) {
  if (!isAdmin(interaction)) {
    await interaction.reply({ content: 'Administrator permission required.', flags: MessageFlags.Ephemeral })
    return
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral })

  const stat = interaction.options.getString('stat', true)
  const label = interaction.options.getString('name', true).trim().replace(/:/g, '').trim()
  if (!label) {
    await interaction.editReply('Give the channel a label, for example "Group Members".')
    return
  }

  let value = '...'
  try {
    value = String(await sync.readStat(stat))
  } catch (err) {
    log.warn('initial stat read failed:', err.message)
  }

  // Locked voice channel: visible to everyone, joinable by nobody.
  const channel = await interaction.guild.channels.create({
    name: `${label}: ${value}`,
    type: 2, // GuildVoice
    permissionOverwrites: [
      {
        id: interaction.guild.roles.everyone.id,
        deny: [PermissionFlagsBits.Connect],
        allow: [PermissionFlagsBits.ViewChannel],
      },
      {
        id: interaction.client.user.id,
        allow: [PermissionFlagsBits.Connect, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ViewChannel],
      },
    ],
    reason: `Stat tracker (${stat}) created by ${interaction.user.tag}`,
  })

  db.addTracker(channel.id, stat, label)
  log.info(`Tracker created: #${channel.name} (${stat})`)
  await interaction.editReply(
    `Tracker created: ${channel}. The number updates automatically (Discord allows channel renames about every 6 minutes). Delete the channel to remove the tracker.`
  )
}

// ---------------------------------------------------------------
// /ping
// ---------------------------------------------------------------

async function handlePing(interaction) {
  const sent = Date.now()
  await interaction.reply({ content: 'Pinging...', flags: MessageFlags.Ephemeral })
  const roundTrip = Date.now() - sent
  const ws = Math.max(0, Math.round(interaction.client.ws.ping))
  const vrchatOk = await sync.vrchatHealthy()
  await interaction.editReply(
    [
      `**Pong!**`,
      `Discord round trip: **${roundTrip}ms** | Gateway: **${ws}ms**`,
      `VRChat API: ${vrchatOk ? '**authenticated**' : '**not authenticated** (check credentials in .env)'}`,
      `Links: **${db.listLinks().length}** | Linked roles: **${db.listLinkedRoles().length}** | Trackers: **${db.listTrackers().length}**`,
    ].join('\n')
  )
}

// ---------------------------------------------------------------
// /get-member-info
// ---------------------------------------------------------------

function trimField(text, max = 1024) {
  const s = String(text || '').trim()
  if (!s) return 'None'
  return s.length > max ? `${s.slice(0, max - 3)}...` : s
}

async function handleGetMemberInfo(interaction) {
  if (!isAdmin(interaction)) {
    await interaction.reply({ content: 'Administrator permission required.', flags: MessageFlags.Ephemeral })
    return
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral })

  const query = interaction.options.getString('user', true).trim()
  let user
  try {
    user = await vrc.resolveUser(query)
  } catch (err) {
    log.error('/get-member-info lookup failed:', err.message)
    await interaction.editReply('VRChat lookup failed. Try again in a minute.')
    return
  }
  if (!user) {
    await interaction.editReply(`No VRChat user found for **${query}**.`)
    return
  }

  let groupMember = null
  try {
    groupMember = await vrc.getGroupMember(user.id)
  } catch {
    /* not a member or API hiccup; show profile anyway */
  }

  let groupRoleNames = 'Not a member'
  if (groupMember) {
    try {
      const roles = await sync.getCachedGroupRoles()
      const names = (groupMember.roleIds || [])
        .map((id) => roles.find((r) => r.id === id)?.name || id)
      groupRoleNames = names.length ? names.join(', ') : 'Member (no roles)'
    } catch {
      groupRoleNames = `Member (${(groupMember.roleIds || []).length} roles)`
    }
  }

  const link = db.getLinkByVrchat(user.id)
  const rank = vrc.getTrustRank(user)
  const avatarImage = user.profilePicOverride || user.currentAvatarImageUrl || null

  const embed = {
    title: user.displayName,
    url: `https://vrchat.com/home/user/${user.id}`,
    color: EMBED_COLOR,
    thumbnail: avatarImage ? { url: avatarImage } : undefined,
    fields: [
      { name: 'User ID', value: `\`${user.id}\``, inline: false },
      { name: 'Trust rank', value: rank.label, inline: true },
      { name: 'VRC+', value: vrc.hasVrcPlus(user) ? 'Yes' : 'No', inline: true },
      { name: '18+ verified', value: vrc.isAgeVerified18Plus(user) ? 'Yes' : 'No', inline: true },
      { name: 'Status', value: `${user.status || 'unknown'}${user.statusDescription ? ` (${trimField(user.statusDescription, 100)})` : ''}`, inline: true },
      { name: 'Platform', value: user.last_platform || 'unknown', inline: true },
      { name: 'Date joined', value: user.date_joined ? discordTime(Date.parse(user.date_joined), 'D') : 'unknown', inline: true },
      { name: 'Last login', value: user.last_login ? discordTime(Date.parse(user.last_login), 'F') : 'unknown', inline: true },
      { name: 'Pronouns', value: trimField(user.pronouns, 50), inline: true },
      { name: 'Discord link', value: link ? `<@${link.discord_id}>` : 'Not linked', inline: true },
      { name: 'Group roles', value: trimField(groupRoleNames), inline: false },
      { name: 'Languages', value: trimField((user.tags || []).filter((t) => t.startsWith('language_')).map((t) => t.slice(9)).join(', ') || 'None', 200), inline: false },
      { name: 'Bio', value: trimField(user.bio), inline: false },
    ],
    footer: { text: 'VRChat-Discord Group Link' },
    timestamp: new Date().toISOString(),
  }

  const bioLinks = Array.isArray(user.bioLinks) ? user.bioLinks.filter(Boolean) : []
  if (bioLinks.length) {
    embed.fields.push({ name: 'Bio links', value: trimField(bioLinks.join('\n'), 500), inline: false })
  }

  await interaction.editReply({ embeds: [embed] })
}

// ---------------------------------------------------------------
// /setup-misc-roles
// ---------------------------------------------------------------

const MISC_ROLE_DEFS = [
  { key: 'age_18', name: '18+', color: 0xe01b24 },
  { key: 'vrc_plus', name: 'VRC+', color: 0xffd166 },
  { key: 'rank_trusted', name: 'Trusted User', color: 0x8143e6 },
  { key: 'rank_known', name: 'Known User', color: 0xff7b42 },
  { key: 'rank_user', name: 'User', color: 0x2bcf5c },
  { key: 'rank_new_user', name: 'New User', color: 0x1778ff },
  { key: 'rank_visitor', name: 'Visitor', color: 0xcccccc },
]

async function handleSetupMiscRoles(interaction) {
  if (!isAdmin(interaction)) {
    await interaction.reply({ content: 'Administrator permission required.', flags: MessageFlags.Ephemeral })
    return
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral })

  const existing = db.getMiscRoles()
  const lines = []
  for (const def of MISC_ROLE_DEFS) {
    let role = existing[def.key] ? interaction.guild.roles.cache.get(existing[def.key]) : null
    if (!role) {
      role = interaction.guild.roles.cache.find((r) => r.name === def.name && !r.managed) || null
    }
    if (!role) {
      role = await interaction.guild.roles.create({
        name: def.name,
        color: def.color,
        mentionable: false,
        reason: 'VRChat-Discord Group Link misc role',
      })
      lines.push(`Created **@${def.name}**`)
    } else {
      lines.push(`Using existing **@${def.name}**`)
    }
    db.setMiscRole(def.key, role.id)
  }

  log.info('Misc roles configured')
  await interaction.editReply(
    `${lines.join('\n')}\n\nLinked members now receive these automatically based on their VRChat profile (18+, VRC+, and their trust rank).`
  )
}

// ---------------------------------------------------------------
// router
// ---------------------------------------------------------------

async function handleInteraction(interaction) {
  if (interaction.isAutocomplete()) {
    if (interaction.commandName === 'set-linked-role') await handleVrchatRoleAutocomplete(interaction)
    return
  }

  if (interaction.isButton()) {
    if (interaction.customId === 'link_verify') await handleLinkVerify(interaction)
    else if (interaction.customId === 'link_cancel') await handleLinkCancel(interaction)
    return
  }

  if (interaction.isStringSelectMenu()) {
    if (interaction.customId === 'link_pick') await handleLinkPick(interaction)
    return
  }

  if (!interaction.isChatInputCommand()) return

  const handlers = {
    link: handleLink,
    unlink: handleUnlink,
    'set-linked-role': handleSetLinkedRole,
    'remove-linked-role': handleRemoveLinkedRole,
    'list-linked-roles': handleListLinkedRoles,
    track: handleTrack,
    ping: handlePing,
    'get-member-info': handleGetMemberInfo,
    'setup-misc-roles': handleSetupMiscRoles,
  }
  const handler = handlers[interaction.commandName]
  if (handler) await handler(interaction)
}

module.exports = { handleInteraction, MISC_ROLE_DEFS }
