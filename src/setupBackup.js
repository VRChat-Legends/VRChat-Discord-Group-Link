'use strict'

// JSON backup of everything the setup commands create: the log channel id
// for every config.yml key and the Discord role id for every misc role
// key. If config.yml or the database is ever lost or wiped, the setup
// commands read this file and offer to reconnect the existing channels
// and roles instead of silently creating duplicates.

const fs = require('fs')
const path = require('path')
const config = require('./config')
const logger = require('./logger')

const log = logger('SetupBackup')

const FILE = path.join(config.dataDir, 'setup-backup.json')

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function write(patch) {
  const next = { ...load(), ...patch, saved_at: new Date().toISOString() }
  try {
    fs.mkdirSync(config.dataDir, { recursive: true })
    fs.writeFileSync(FILE, JSON.stringify(next, null, 2))
  } catch (err) {
    log.warn('could not write setup backup:', err.message)
  }
}

// Snapshot every channel id currently in the live config, in the same
// section/key shape config.writeChannelIds takes.
function channelSnapshot() {
  const out = { logs: {}, group_logs: {}, feeds: {} }
  out.logs.link_channel_id = config.logs.linkChannelId
  out.logs.role_channel_id = config.logs.roleChannelId
  out.logs.alert_channel_id = config.logs.alertChannelId
  for (const [cat, id] of Object.entries(config.groupLogs.channels)) {
    out.group_logs[`${cat}_channel_id`] = id
  }
  out.feeds.posts_channel_id = config.feeds.postsChannelId
  out.feeds.join_requests_channel_id = config.feeds.joinRequestsChannelId
  return out
}

function saveChannels() {
  write({ channels: channelSnapshot() })
}

// Backed up channel ids as [{ section, key, id }], ready for
// config.writeChannelIds. Empty ids are dropped.
function savedChannelAssignments() {
  const saved = load().channels
  if (!saved || typeof saved !== 'object') return []
  const list = []
  for (const [section, keys] of Object.entries(saved)) {
    if (!keys || typeof keys !== 'object') continue
    for (const [key, id] of Object.entries(keys)) {
      const clean = String(id || '').trim()
      if (clean) list.push({ section, key, id: clean })
    }
  }
  return list
}

function saveMiscRoles(map) {
  write({ misc_roles: map && typeof map === 'object' ? map : {} })
}

function savedMiscRoles() {
  const saved = load().misc_roles
  return saved && typeof saved === 'object' ? { ...saved } : {}
}

module.exports = { FILE, load, saveChannels, savedChannelAssignments, saveMiscRoles, savedMiscRoles }
