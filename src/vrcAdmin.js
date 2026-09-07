'use strict'

// Admin tooling that talks to the VRChat group: real ban, kick, and unban,
// the ban list, member search, a full membership audit, and the Accept and
// Deny buttons on join requests. Everything here is administrator gated.

const { AttachmentBuilder, MessageFlags, PermissionFlagsBits } = require('discord.js')

const config = require('./config')
const logger = require('./logger')
const db = require('./db')
const vrc = require('./vrchatApi')
const sync = require('./sync')
const roster = require('./roster')
const actions = require('./vrcActions')

const log = logger('VRCAdmin')
const EMBED_COLOR = 0x8143e6
const BANS_PER_PAGE = 10

function isAdmin(interaction) {
  return Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.Administrator))
}

async function denyIfNotAdmin(interaction) {
  if (isAdmin(interaction)) return false
  await interaction.reply({ content: 'Administrator permission required.', flags: MessageFlags.Ephemeral })
  return true
}

// Ban, kick, and unban obey the moderator allow list in config.yml.
async function denyIfNotModerator(interaction) {
  if (actions.canModerate(interaction)) return false
  await interaction.reply({ content: actions.moderatorDeniedMessage(), flags: MessageFlags.Ephemeral })
  return true
}

function profileLink(id, name) {
  return `[${name || id}](https://vrchat.com/home/user/${id})`
}

// ---------------------------------------------------------------
// /vrc-ban, /vrc-kick, /vrc-unban
// ---------------------------------------------------------------

async function runActionCommand(interaction, action) {
  if (await denyIfNotModerator(interaction)) return
  await interaction.deferReply({ flags: MessageFlags.Ephemeral })

  const query = interaction.options.getString('user', true).trim()
  const reason = interaction.options.getString('reason')?.trim() || ''

  let user
  try {
    user = await vrc.resolveUser(query)
  } catch (err) {
    log.warn(`/${action} lookup failed:`, err.message)
    await interaction.editReply('VRChat lookup failed. Try again in a minute.')
    return
  }

  // Unban targets are not searchable as members, so fall back to a raw id.
  const targetId = user?.id || (/^usr_/.test(query) ? query : null)
  if (!targetId) {
    await interaction.editReply(`No VRChat user found for **${query}**. Paste the full \`usr_...\` id if the name does not resolve.`)
    return
  }

  const result = await actions.runAction(action, targetId, {
    reason,
    byTag: interaction.user.tag,
    byDiscordId: interaction.user.id,
  })
  await interaction.editReply(result.message)
}

const handleVrcBan = (interaction) => runActionCommand(interaction, 'ban')
const handleVrcKick = (interaction) => runActionCommand(interaction, 'kick')
const handleVrcUnban = (interaction) => runActionCommand(interaction, 'unban')

// ---------------------------------------------------------------
// /vrc-bans
// ---------------------------------------------------------------

function bansComponents(offset, hasNext) {
  return [{
    type: 1,
    components: [
      { type: 2, style: 2, custom_id: `bans_page:${Math.max(0, offset - BANS_PER_PAGE)}`, label: 'Previous', disabled: offset <= 0 },
      { type: 2, style: 2, custom_id: `bans_page:${offset + BANS_PER_PAGE}`, label: 'Next', disabled: !hasNext },
    ],
  }]
}

async function buildBansPage(offset) {
  // Ask for one extra so we know whether a next page exists.
  const bans = await vrc.getGroupBans({ n: BANS_PER_PAGE + 1, offset })
  const hasNext = bans.length > BANS_PER_PAGE
  const page = bans.slice(0, BANS_PER_PAGE)

  const lines = page.map((ban, i) => {
    const id = ban.userId || ban.user?.id || 'unknown'
    const name = ban.user?.displayName || id
    const when = Date.parse(ban.bannedAt || ban.createdAt || '')
    const stamp = Number.isFinite(when) ? ` | <t:${Math.floor(when / 1000)}:d>` : ''
    const link = db.getLinkByVrchat(id)
    return `**${offset + i + 1}.** ${profileLink(id, name)}${stamp}${link ? ` | <@${link.discord_id}>` : ''}\n\`${id}\``
  })

  return {
    embeds: [{
      title: 'VRChat Group Bans',
      color: EMBED_COLOR,
      description: lines.join('\n') || 'No bans on this page.',
      footer: { text: `Showing ${page.length ? offset + 1 : offset} to ${offset + page.length}` },
      timestamp: new Date().toISOString(),
    }],
    components: bansComponents(offset, hasNext),
  }
}

async function handleVrcBans(interaction) {
  if (await denyIfNotAdmin(interaction)) return
  await interaction.deferReply({ flags: MessageFlags.Ephemeral })
  try {
    await interaction.editReply(await buildBansPage(0))
  } catch (err) {
    log.warn('/vrc-bans failed:', err.message)
    await interaction.editReply(`Could not read the ban list: ${err.vrchatMessage || err.message}`)
  }
}

async function handleBansPageButton(interaction) {
  const offset = Math.max(0, Number(interaction.customId.split(':')[1]) || 0)
  await interaction.deferUpdate()
  try {
    await interaction.editReply(await buildBansPage(offset))
  } catch (err) {
    log.warn('ban page failed:', err.message)
  }
}

// ---------------------------------------------------------------
// /vrc-search
// ---------------------------------------------------------------

async function handleVrcSearch(interaction) {
  if (await denyIfNotAdmin(interaction)) return
  await interaction.deferReply({ flags: MessageFlags.Ephemeral })

  const query = interaction.options.getString('query', true).trim()
  if (query.length < 3) {
    await interaction.editReply('VRChat needs at least three characters to search the member list.')
    return
  }

  let members
  try {
    members = await vrc.searchGroupMembers(query, { n: 10 })
  } catch (err) {
    log.warn('/vrc-search failed:', err.message)
    await interaction.editReply(`Search failed: ${err.vrchatMessage || err.message}`)
    return
  }

  if (!members.length) {
    await interaction.editReply(`No group members matched **${query}**.`)
    return
  }

  const lines = members.map((m) => {
    const id = m.userId || m.user?.id || 'unknown'
    const name = m.user?.displayName || id
    const joined = Date.parse(m.joinedAt || '')
    const link = db.getLinkByVrchat(id)
    return [
      `**${name}** ${m.isRepresenting ? '(repping)' : ''}`,
      `\`${id}\``,
      Number.isFinite(joined) ? `Joined <t:${Math.floor(joined / 1000)}:D>` : null,
      link ? `Discord: <@${link.discord_id}>` : 'Not linked',
      m.managerNotes ? `Notes: ${String(m.managerNotes).slice(0, 200)}` : null,
    ].filter(Boolean).join(' | ')
  })

  await interaction.editReply({
    embeds: [{
      title: `Group member search: ${query}`.slice(0, 256),
      color: EMBED_COLOR,
      description: lines.join('\n\n').slice(0, 4000),
      footer: { text: `${members.length} match${members.length === 1 ? '' : 'es'}` },
      timestamp: new Date().toISOString(),
    }],
  })
}

// ---------------------------------------------------------------
// /vrc-role-members
// ---------------------------------------------------------------

const ROLE_MEMBER_PREVIEW = 25

async function handleVrcRoleMembers(interaction) {
  if (await denyIfNotAdmin(interaction)) return
  await interaction.deferReply({ flags: MessageFlags.Ephemeral })

  const roleId = interaction.options.getString('vrchat_role', true)
  let roleName = roleId
  try {
    const roles = await sync.getCachedGroupRoles()
    roleName = roles.find((r) => r.id === roleId)?.name || roleId
  } catch { /* the id alone is enough to answer */ }

  // The cached roster answers for free; the API is only asked when it has not loaded, and then for one page.
  let members = []
  let truncated = false
  try {
    if (roster.isLoaded()) {
      members = roster.withRole(roleId)
    } else {
      members = await vrc.getGroupMembers({ roleId, n: 100 })
      truncated = members.length >= 100
    }
  } catch (err) {
    log.warn('/vrc-role-members failed:', err.message)
    await interaction.editReply(`Could not read the member list: ${err.vrchatMessage || err.message}`)
    return
  }

  const lines = members.slice(0, ROLE_MEMBER_PREVIEW).map((m) => {
    const id = m.userId || m.user?.id || 'unknown'
    const name = m.user?.displayName || id
    const link = db.getLinkByVrchat(id)
    return `${profileLink(id, name)}${link ? ` | <@${link.discord_id}>` : ''}`
  })

  const linkedCount = members.filter((m) => db.getLinkByVrchat(m.userId || m.user?.id || '')).length
  const files = []
  if (members.length > ROLE_MEMBER_PREVIEW) {
    const full = members.map((m) => {
      const id = m.userId || m.user?.id || '?'
      const link = db.getLinkByVrchat(id)
      return `${m.user?.displayName || '?'} | ${id} | discord ${link?.discord_id || 'not linked'}`
    })
    files.push(new AttachmentBuilder(Buffer.from(full.join('\n'), 'utf8'), { name: 'role-members.txt' }))
  }

  await interaction.editReply({
    embeds: [{
      title: `VRChat role: ${roleName}`.slice(0, 256),
      color: EMBED_COLOR,
      description: lines.join('\n').slice(0, 4000) || 'Nobody holds this role.',
      fields: [
        { name: 'Holders', value: `${members.length}${truncated ? '+' : ''}`, inline: true },
        { name: 'Linked to Discord', value: String(linkedCount), inline: true },
      ],
      footer: {
        text: members.length > ROLE_MEMBER_PREVIEW
          ? `Showing ${ROLE_MEMBER_PREVIEW} of ${members.length}; full list attached`
          : roster.isLoaded() ? `From the cached member list, ${Math.round(roster.ageMs() / 1000)}s old` : 'Live from VRChat',
      },
      timestamp: new Date().toISOString(),
    }],
    files,
  })
}

// ---------------------------------------------------------------
// /vrc-invite
// ---------------------------------------------------------------

async function handleVrcInvite(interaction) {
  if (await denyIfNotModerator(interaction)) return
  await interaction.deferReply({ flags: MessageFlags.Ephemeral })

  const query = interaction.options.getString('user', true).trim()
  let user = null
  try {
    user = await vrc.resolveUser(query)
  } catch (err) {
    log.warn('/vrc-invite lookup failed:', err.message)
  }

  const targetId = user?.id || (/^usr_/.test(query) ? query : null)
  if (!targetId) {
    await interaction.editReply(`No VRChat user found for **${query}**. Paste the full \`usr_...\` id if the name does not resolve.`)
    return
  }

  if (roster.get(targetId)) {
    await interaction.editReply(`**${user?.displayName || targetId}** is already in the group.`)
    return
  }

  try {
    await vrc.createGroupInvite(targetId)
  } catch (err) {
    log.warn('/vrc-invite failed:', err.message)
    await interaction.editReply(actions.friendlyError(err))
    return
  }

  const name = user?.displayName || targetId
  log.info(`Invited ${name} (${targetId}) to the group, by ${interaction.user.tag}`)
  await interaction.editReply(`Group invite sent to **${name}**.`)
}

// ---------------------------------------------------------------
// /vrc-post
// ---------------------------------------------------------------

async function handleVrcPost(interaction) {
  if (await denyIfNotModerator(interaction)) return
  await interaction.deferReply({ flags: MessageFlags.Ephemeral })

  const title = interaction.options.getString('title', true).trim()
  const text = interaction.options.getString('text', true).trim()
  const visibility = interaction.options.getString('visibility') || 'group'
  const notify = interaction.options.getBoolean('notify') ?? false

  try {
    await vrc.createGroupPost({ title, text, visibility, sendNotification: notify })
  } catch (err) {
    log.warn('/vrc-post failed:', err.message)
    await interaction.editReply(actions.friendlyError(err))
    return
  }

  log.info(`Group post created by ${interaction.user.tag}: ${title}`)
  await interaction.editReply({
    content: 'Posted to the VRChat group.',
    embeds: [{
      title: title.slice(0, 256),
      color: EMBED_COLOR,
      description: text.slice(0, 4000),
      fields: [
        { name: 'Visibility', value: visibility === 'public' ? 'Public' : 'Group members', inline: true },
        { name: 'Notification', value: notify ? 'Sent' : 'None', inline: true },
        { name: 'By', value: `<@${interaction.user.id}>`, inline: true },
      ],
      timestamp: new Date().toISOString(),
    }],
  })
}

// ---------------------------------------------------------------
// /group-info
// ---------------------------------------------------------------

// Anyone can run this, so the two reads behind it are shared for a minute rather than spent per invocation.
const GROUP_INFO_TTL_MS = 60_000
let groupInfoCache = { at: 0, group: null, instances: [] }

async function readGroupInfo() {
  if (Date.now() - groupInfoCache.at < GROUP_INFO_TTL_MS) return groupInfoCache
  const group = await vrc.getGroup()
  let instances = []
  try {
    instances = await vrc.getGroupInstances()
  } catch { /* instances are a bonus, not the point */ }
  groupInfoCache = { at: Date.now(), group, instances }
  return groupInfoCache
}

async function handleGroupInfo(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral })

  let group = null
  let instances = []
  try {
    ({ group, instances } = await readGroupInfo())
  } catch (err) {
    log.warn('/group-info failed:', err.message)
    await interaction.editReply(`Could not read the group: ${err.vrchatMessage || err.message}`)
    return
  }
  if (!group) {
    await interaction.editReply('VRChat did not return the group. Check VRCHAT_GROUP_ID in .env.')
    return
  }

  const inInstances = instances.reduce((sum, i) => sum + Number(i?.memberCount ?? i?.nUsers ?? 0), 0)

  const created = Date.parse(group.createdAt || '')
  const fields = [
    { name: 'Members', value: String(group.memberCount ?? 'unknown'), inline: true },
    { name: 'Linked to Discord', value: String(db.countLinks()), inline: true },
    { name: 'Online now', value: `${inInstances} in ${instances.length} instance${instances.length === 1 ? '' : 's'}`, inline: true },
    { name: 'Short code', value: group.shortCode ? `${group.shortCode}.${group.discriminator}` : 'unknown', inline: true },
    { name: 'Join type', value: String(group.joinState || 'unknown'), inline: true },
    { name: 'Roles', value: String(group.roles?.length ?? (group.numRoles ?? 'unknown')), inline: true },
  ]
  if (Number.isFinite(created)) {
    fields.push({ name: 'Created', value: `<t:${Math.floor(created / 1000)}:D>`, inline: true })
  }
  if (group.description) {
    fields.push({ name: 'Description', value: String(group.description).slice(0, 1024), inline: false })
  }

  await interaction.editReply({
    embeds: [{
      title: String(group.name || 'VRChat group').slice(0, 256),
      url: group.id ? `https://vrchat.com/home/group/${group.id}` : undefined,
      color: EMBED_COLOR,
      fields,
      thumbnail: group.iconUrl ? { url: group.iconUrl } : undefined,
      image: group.bannerUrl ? { url: group.bannerUrl } : undefined,
      timestamp: new Date().toISOString(),
    }],
  })
}

// ---------------------------------------------------------------
// /audit-members
// ---------------------------------------------------------------

async function fetchAllMembers(max = 6000) {
  const all = []
  for (let offset = 0; offset < max; offset += 100) {
    const page = await vrc.getGroupMembers({ n: 100, offset, sort: 'joinedAt:desc' })
    all.push(...page)
    if (page.length < 100) break
  }
  return all
}

async function handleAuditMembers(interaction) {
  if (await denyIfNotAdmin(interaction)) return
  await interaction.deferReply({ flags: MessageFlags.Ephemeral })
  await interaction.editReply('Walking the whole group member list. This takes a couple of minutes because of the VRChat rate limit.')

  let members
  try {
    members = await fetchAllMembers()
  } catch (err) {
    log.warn('/audit-members failed:', err.message)
    await interaction.editReply(`Audit failed: ${err.vrchatMessage || err.message}`)
    return
  }

  const memberById = new Map()
  for (const m of members) {
    const id = m.userId || m.user?.id
    if (id) memberById.set(id, m)
  }

  const links = db.listLinks()
  const linkedIds = new Set(links.map((l) => l.vrchat_id))

  const leftGroup = links.filter((l) => !memberById.has(l.vrchat_id))
  const unlinkedMembers = members.filter((m) => !linkedIds.has(m.userId || m.user?.id || ''))

  let bans = []
  try {
    for (let offset = 0; offset < 500; offset += 100) {
      const page = await vrc.getGroupBans({ n: 100, offset })
      bans.push(...page)
      if (page.length < 100) break
    }
  } catch (err) {
    log.warn('ban list during audit failed:', err.message)
  }
  const bannedLinked = bans
    .map((b) => ({ id: b.userId || b.user?.id, name: b.user?.displayName }))
    .filter((b) => b.id && linkedIds.has(b.id))

  const lines = []
  lines.push('VRChat group membership audit')
  lines.push(`Generated: ${new Date().toISOString()}`)
  lines.push(`Group members: ${members.length}`)
  lines.push(`Discord links: ${links.length}`)
  lines.push('')
  lines.push(`== Linked users who are NOT in the group (${leftGroup.length}) ==`)
  for (const l of leftGroup) lines.push(`${l.vrchat_name || '?'} | ${l.vrchat_id} | discord ${l.discord_id}`)
  lines.push('')
  lines.push(`== Banned users who still have a Discord link (${bannedLinked.length}) ==`)
  for (const b of bannedLinked) {
    const l = links.find((x) => x.vrchat_id === b.id)
    lines.push(`${b.name || l?.vrchat_name || '?'} | ${b.id} | discord ${l?.discord_id || '?'}`)
  }
  lines.push('')
  lines.push(`== Group members with no Discord link (${unlinkedMembers.length}) ==`)
  for (const m of unlinkedMembers) {
    lines.push(`${m.user?.displayName || '?'} | ${m.userId || m.user?.id || '?'} | joined ${m.joinedAt || '?'}`)
  }

  const file = new AttachmentBuilder(Buffer.from(lines.join('\n'), 'utf8'), { name: 'vrchat-member-audit.txt' })

  await interaction.editReply({
    content: '',
    embeds: [{
      title: 'Group Membership Audit',
      color: EMBED_COLOR,
      fields: [
        { name: 'Group members', value: String(members.length), inline: true },
        { name: 'Discord links', value: String(links.length), inline: true },
        { name: 'Linked but not in group', value: String(leftGroup.length), inline: true },
        { name: 'Banned with a live link', value: String(bannedLinked.length), inline: true },
        { name: 'Members with no link', value: String(unlinkedMembers.length), inline: true },
        {
          name: 'Linked but not in group (first 10)',
          value: leftGroup.slice(0, 10).map((l) => `${profileLink(l.vrchat_id, l.vrchat_name)} | <@${l.discord_id}>`).join('\n') || 'None',
          inline: false,
        },
      ],
      footer: { text: 'Full detail in the attached file' },
      timestamp: new Date().toISOString(),
    }],
    files: [file],
  })
}

// ---------------------------------------------------------------
// /recheck-roles
// ---------------------------------------------------------------

async function handleRecheckRoles(interaction) {
  if (await denyIfNotAdmin(interaction)) return
  await interaction.deferReply({ flags: MessageFlags.Ephemeral })

  const problems = await sync.miscRoleHealth(interaction.client)
  const miscRoles = db.getMiscRoles()
  const target = interaction.options.getUser('member')

  if (!Object.keys(miscRoles).length && !db.listLinkedRoles().length) {
    await interaction.editReply('Nothing is set up to sync yet. Run **/setup-misc-roles** or **/set-linked-role** first, then try again.')
    return
  }

  if (target) {
    const link = db.getLinkByDiscord(target.id)
    if (!link) {
      await interaction.editReply(`<@${target.id}> has no linked VRChat account, so there is nothing to sync.`)
      return
    }

    let result
    try {
      // A one member recheck is worth the calls: fresh profile and a direct membership answer instead of cached ones.
      result = await sync.syncOneUser(interaction.client, target.id, { verify: true, refreshProfile: true })
    } catch (err) {
      log.warn('/recheck-roles single sync failed:', err.message)
      await interaction.editReply(`Sync failed: ${err.vrchatMessage || err.message}`)
      return
    }

    const member = await interaction.guild.members.fetch(target.id).catch(() => null)
    const held = Object.entries(miscRoles)
      .filter(([, roleId]) => member?.roles.cache.has(roleId))
      .map(([key, roleId]) => `<@&${roleId}> (${key})`)
    const linked = db.listLinkedRoles()
      .filter((p) => member?.roles.cache.has(p.discord_role_id))
      .map((p) => `<@&${p.discord_role_id}> to ${p.vrchat_role_name}`)

    await interaction.editReply({
      embeds: [{
        title: 'Roles rechecked',
        color: EMBED_COLOR,
        fields: [
          { name: 'Member', value: `<@${target.id}>`, inline: true },
          { name: 'VRChat', value: profileLink(link.vrchat_id, link.vrchat_name), inline: true },
          { name: 'In the group', value: result?.inGroup ? 'Yes' : result?.groupKnown ? 'No' : 'Could not tell', inline: true },
          { name: 'Changes made', value: String(result?.changed ?? 0), inline: true },
          { name: 'Profile roles held', value: held.join('\n') || 'None', inline: false },
          { name: 'Linked roles held', value: linked.join('\n') || 'None', inline: false },
          { name: 'Blocking problems', value: problems.join('\n\n') || 'None found', inline: false },
        ],
        timestamp: new Date().toISOString(),
      }],
    })
    return
  }

  await interaction.editReply('Running a full pass over every linked member. This reads the cached group roster, so it does not hammer VRChat.')

  let result
  try {
    result = await sync.runCycle(interaction.client)
  } catch (err) {
    log.warn('/recheck-roles sweep failed:', err.message)
    await interaction.editReply(`Sync failed: ${err.vrchatMessage || err.message}`)
    return
  }

  if (result?.skipped) {
    await interaction.editReply('A sync pass is already running right now. Give it a moment and check **/sync-status**.')
    return
  }

  await interaction.editReply({
    content: '',
    embeds: [{
      title: 'Roles rechecked',
      color: EMBED_COLOR,
      fields: [
        { name: 'Members checked', value: `${result?.checked ?? 0} of ${db.countLinks()}`, inline: true },
        { name: 'Role changes made', value: String(result?.changed ?? 0), inline: true },
        { name: 'Profiles refreshed', value: String(result?.profiles ?? 0), inline: true },
        { name: 'Blocking problems', value: problems.join('\n\n') || 'None found', inline: false },
      ],
      footer: { text: 'The bot runs this pass on its own schedule too; see /sync-status' },
      timestamp: new Date().toISOString(),
    }],
  })
}

// ---------------------------------------------------------------
// join request buttons
// ---------------------------------------------------------------

async function handleJoinRequestButton(interaction) {
  const [kind, userId] = interaction.customId.split(':')
  if (await denyIfNotModerator(interaction)) return
  await interaction.deferReply({ flags: MessageFlags.Ephemeral })

  const accept = kind === 'jr_accept'
  const block = kind === 'jr_block'

  try {
    await vrc.respondToJoinRequest(userId, accept ? 'accept' : 'reject', { block })
  } catch (err) {
    log.warn(`join request ${kind} failed:`, err.message)
    await interaction.editReply(actions.friendlyError(err))
    return
  }

  const verdict = accept ? 'accepted' : block ? 'denied and blocked' : 'denied'
  await interaction.editReply(`Join request ${verdict}.`)

  const embed = interaction.message.embeds[0]?.toJSON?.() || interaction.message.embeds[0] || {}
  const fields = [...(embed.fields || []), {
    name: 'Resolved',
    value: `${verdict} by <@${interaction.user.id}> <t:${Math.floor(Date.now() / 1000)}:R>`,
    inline: false,
  }]
  await interaction.message.edit({
    embeds: [{ ...embed, fields, color: accept ? 0x33d17a : 0xe01b24 }],
    components: [],
  }).catch(() => null)
}

// ---------------------------------------------------------------
// real ban and kick buttons on group log posts
// ---------------------------------------------------------------

const ACTION_LABELS = { ban: 'Ban', kick: 'Kick', unban: 'Unban' }

async function handleModActionButton(interaction) {
  const [, action, logId] = interaction.customId.split(':')
  if (await denyIfNotModerator(interaction)) return

  const record = db.getModerationLog(logId)
  if (!record?.target_id) {
    await interaction.reply({ content: 'I no longer have the target for this log.', flags: MessageFlags.Ephemeral })
    return
  }
  if (!config.moderation.allowActionsFromDiscord) {
    await interaction.reply({
      content: 'VRChat actions from Discord are turned off in config.yml (moderation.allow_actions_from_discord).',
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  await interaction.reply({
    content: [
      `**Confirm ${ACTION_LABELS[action] || action}**`,
      `Target: **${record.target_name || record.target_id}** (\`${record.target_id}\`)`,
      record.reason ? `Reason on file: ${record.reason}` : 'No reason picked yet.',
      '',
      'This happens in the VRChat group immediately.',
    ].join('\n'),
    flags: MessageFlags.Ephemeral,
    components: [{
      type: 1,
      components: [
        { type: 2, style: action === 'unban' ? 3 : 4, custom_id: `mod_go:${action}:${logId}`, label: `Yes, ${ACTION_LABELS[action] || action}` },
        { type: 2, style: 2, custom_id: 'mod_cancel', label: 'Cancel' },
      ],
    }],
  })
}

async function handleModActionConfirm(interaction) {
  const [, action, logId] = interaction.customId.split(':')
  if (await denyIfNotModerator(interaction)) return
  await interaction.deferUpdate()

  const record = db.getModerationLog(logId)
  if (!record?.target_id) {
    await interaction.editReply({ content: 'I no longer have the target for this log.', components: [] })
    return
  }

  const result = await actions.runAction(action, record.target_id, {
    reason: record.reason || '',
    byTag: interaction.user.tag,
    byDiscordId: interaction.user.id,
  })

  await interaction.editReply({ content: result.message, components: [] })

  if (result.ok) {
    db.setModerationAction(logId, action, interaction.user.id)
    const original = await interaction.channel?.messages?.fetch(record.message_id).catch(() => null)
    if (original) {
      const embed = original.embeds[0]?.toJSON?.() || original.embeds[0]
      if (embed) {
        const fields = [...(embed.fields || []).filter((f) => f.name !== 'Action taken'), {
          name: 'Action taken',
          value: `${ACTION_LABELS[action] || action} by <@${interaction.user.id}> <t:${Math.floor(Date.now() / 1000)}:R>`,
          inline: false,
        }]
        await original.edit({ embeds: [{ ...embed, fields }] }).catch(() => null)
      }
    }
  }
}

async function handleModCancel(interaction) {
  await interaction.update({ content: 'Cancelled. Nothing was changed in VRChat.', components: [] })
}

module.exports = {
  handleVrcBan,
  handleVrcKick,
  handleVrcUnban,
  handleVrcBans,
  handleBansPageButton,
  handleVrcSearch,
  handleVrcRoleMembers,
  handleVrcInvite,
  handleVrcPost,
  handleGroupInfo,
  handleAuditMembers,
  handleRecheckRoles,
  handleJoinRequestButton,
  handleModActionButton,
  handleModActionConfirm,
  handleModCancel,
}
