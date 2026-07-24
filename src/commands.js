'use strict'

// Slash command definitions + guild registration.

const { ChannelType, PermissionFlagsBits, REST, Routes, SlashCommandBuilder } = require('discord.js')
const config = require('./config')
const logger = require('./logger')

const log = logger('Commands')

function buildCommands() {
  const link = new SlashCommandBuilder()
    .setName('link')
    .setDescription('Link your Discord account to your VRChat account')
    .addStringOption((o) => o
      .setName('vrchat_user')
      .setDescription('Your VRChat display name or usr_ ID')
      .setRequired(true)
      .setMaxLength(64))

  const unlink = new SlashCommandBuilder()
    .setName('unlink')
    .setDescription('Remove the link between your Discord and VRChat accounts')

  const setLinkedRole = new SlashCommandBuilder()
    .setName('set-linked-role')
    .setDescription('Link a Discord role to a VRChat group role (two way sync)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addRoleOption((o) => o
      .setName('discord_role')
      .setDescription('The Discord role')
      .setRequired(true))
    .addStringOption((o) => o
      .setName('vrchat_role')
      .setDescription('The VRChat group role (start typing to search)')
      .setRequired(true)
      .setAutocomplete(true))

  const removeLinkedRole = new SlashCommandBuilder()
    .setName('remove-linked-role')
    .setDescription('Remove a Discord to VRChat role link')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addRoleOption((o) => o
      .setName('discord_role')
      .setDescription('The Discord role to unlink')
      .setRequired(true))

  const listLinkedRoles = new SlashCommandBuilder()
    .setName('list-linked-roles')
    .setDescription('List every Discord to VRChat role link')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)

  const track = new SlashCommandBuilder()
    .setName('track')
    .setDescription('Create a locked voice channel that shows a live VRChat group stat')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption((o) => o
      .setName('stat')
      .setDescription('Which stat to track')
      .setRequired(true)
      .addChoices(
        { name: 'Group members', value: 'group_members' },
        { name: 'Users in instances', value: 'users_in_instances' },
        { name: 'Open instances', value: 'open_instances' },
      ))
    .addStringOption((o) => o
      .setName('name')
      .setDescription('Channel label (shown as "label: number")')
      .setRequired(true)
      .setMaxLength(60))

  const ping = new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Bot latency and VRChat API status')

  const getMemberInfo = new SlashCommandBuilder()
    .setName('get-member-info')
    .setDescription('Look up everything about a VRChat user')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption((o) => o
      .setName('user')
      .setDescription('VRChat display name or usr_ ID')
      .setRequired(true)
      .setMaxLength(64))

  const setupMiscRoles = new SlashCommandBuilder()
    .setName('setup-misc-roles')
    .setDescription('Create the 18+, VRC+, and trust rank roles the bot assigns to linked users')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)

  const setupLogChannels = new SlashCommandBuilder()
    .setName('setup-log-channels')
    .setDescription('Create every log channel in a category and fill config.yml automatically')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption((o) => o
      .setName('category')
      .setDescription('The category the log channels go in')
      .addChannelTypes(ChannelType.GuildCategory)
      .setRequired(true))

  return [
    link,
    unlink,
    setLinkedRole,
    removeLinkedRole,
    listLinkedRoles,
    track,
    ping,
    getMemberInfo,
    setupMiscRoles,
    setupLogChannels,
  ].map((c) => c.toJSON())
}

async function registerCommands(applicationId) {
  const rest = new REST({ version: '10' }).setToken(config.discord.token)
  const route = Routes.applicationGuildCommands(applicationId, config.discord.guildId)
  await rest.put(route, { body: buildCommands() })
  log.info('Slash commands registered for guild', config.discord.guildId)
}

module.exports = { registerCommands }
