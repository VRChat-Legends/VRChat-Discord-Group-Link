'use strict'

// Storage for VRChat-Discord Group Link. Uses node:sqlite (built into Node
// 22.5+, zero dependencies) with a single file at data/group-link.sqlite.
// Same zero-setup approach as the VRChat Legends World Bridge store.

const fs = require('fs')
const path = require('path')
const { DatabaseSync } = require('node:sqlite')
const config = require('./config')

let db = null

function getDb() {
  if (db) return db
  fs.mkdirSync(config.dataDir, { recursive: true })
  db = new DatabaseSync(path.join(config.dataDir, 'group-link.sqlite'))
  db.exec(`
    PRAGMA journal_mode = WAL;

    -- Discord user <-> VRChat user links
    CREATE TABLE IF NOT EXISTS links (
      discord_id TEXT PRIMARY KEY,
      vrchat_id TEXT NOT NULL UNIQUE,
      vrchat_name TEXT NOT NULL DEFAULT '',
      linked_at TEXT NOT NULL
    );

    -- One-time bio verification codes
    CREATE TABLE IF NOT EXISTS link_codes (
      discord_id TEXT PRIMARY KEY,
      code TEXT NOT NULL,
      vrchat_id TEXT NOT NULL,
      vrchat_name TEXT NOT NULL DEFAULT '',
      expires_at INTEGER NOT NULL
    );

    -- Discord role <-> VRChat group role pairs
    CREATE TABLE IF NOT EXISTS linked_roles (
      discord_role_id TEXT PRIMARY KEY,
      discord_role_name TEXT NOT NULL DEFAULT '',
      vrchat_role_id TEXT NOT NULL,
      vrchat_role_name TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    -- Last known state per (user, linked role pair) so the sync can tell
    -- which side changed and mirror it to the other side.
    CREATE TABLE IF NOT EXISTS role_state (
      discord_id TEXT NOT NULL,
      discord_role_id TEXT NOT NULL,
      had_discord INTEGER NOT NULL DEFAULT 0,
      had_vrchat INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (discord_id, discord_role_id)
    );

    -- Stat tracker voice channels
    CREATE TABLE IF NOT EXISTS trackers (
      channel_id TEXT PRIMARY KEY,
      stat TEXT NOT NULL,
      label TEXT NOT NULL,
      last_value TEXT NOT NULL DEFAULT '',
      last_renamed_at INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    -- Misc profile roles created by /setup-misc-roles (18+, VRC+, trust ranks)
    CREATE TABLE IF NOT EXISTS misc_roles (
      key TEXT PRIMARY KEY,
      discord_role_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    -- Small key/value store (audit log watermark, seen ids, etc.)
    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT ''
    );

    -- Moderation records behind the reason menu / Request Ban controls
    CREATE TABLE IF NOT EXISTS moderation_logs (
      log_id TEXT PRIMARY KEY,
      audit_id TEXT NOT NULL DEFAULT '',
      event_type TEXT NOT NULL DEFAULT '',
      target_id TEXT NOT NULL DEFAULT '',
      target_name TEXT NOT NULL DEFAULT '',
      actor_name TEXT NOT NULL DEFAULT '',
      location TEXT NOT NULL DEFAULT '',
      occurred_at TEXT NOT NULL DEFAULT '',
      channel_id TEXT NOT NULL DEFAULT '',
      message_id TEXT NOT NULL DEFAULT '',
      reason TEXT NOT NULL DEFAULT '',
      reason_by TEXT NOT NULL DEFAULT '',
      ban_requested_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
  `)
  return db
}

// ---------------------------------------------------------------
// links
// ---------------------------------------------------------------

function getLinkByDiscord(discordId) {
  return getDb().prepare('SELECT * FROM links WHERE discord_id = ?').get(String(discordId)) || null
}

function getLinkByVrchat(vrchatId) {
  return getDb().prepare('SELECT * FROM links WHERE vrchat_id = ?').get(String(vrchatId)) || null
}

function listLinks() {
  return getDb().prepare('SELECT * FROM links ORDER BY linked_at').all()
}

function createLink(discordId, vrchatId, vrchatName) {
  getDb()
    .prepare('INSERT OR REPLACE INTO links (discord_id, vrchat_id, vrchat_name, linked_at) VALUES (?, ?, ?, ?)')
    .run(String(discordId), String(vrchatId), String(vrchatName || ''), new Date().toISOString())
}

function deleteLink(discordId) {
  const db2 = getDb()
  db2.prepare('DELETE FROM role_state WHERE discord_id = ?').run(String(discordId))
  return db2.prepare('DELETE FROM links WHERE discord_id = ?').run(String(discordId)).changes > 0
}

// ---------------------------------------------------------------
// link codes
// ---------------------------------------------------------------

function saveLinkCode(discordId, { code, vrchatId, vrchatName, expiresAt }) {
  getDb()
    .prepare('INSERT OR REPLACE INTO link_codes (discord_id, code, vrchat_id, vrchat_name, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(String(discordId), String(code), String(vrchatId), String(vrchatName || ''), Number(expiresAt))
}

function getLinkCode(discordId) {
  const row = getDb().prepare('SELECT * FROM link_codes WHERE discord_id = ?').get(String(discordId))
  if (!row) return null
  if (row.expires_at < Date.now()) {
    deleteLinkCode(discordId)
    return null
  }
  return row
}

function deleteLinkCode(discordId) {
  getDb().prepare('DELETE FROM link_codes WHERE discord_id = ?').run(String(discordId))
}

function purgeExpiredCodes() {
  return getDb().prepare('DELETE FROM link_codes WHERE expires_at < ?').run(Date.now()).changes
}

// ---------------------------------------------------------------
// linked role pairs
// ---------------------------------------------------------------

function setLinkedRole(discordRoleId, discordRoleName, vrchatRoleId, vrchatRoleName) {
  getDb()
    .prepare('INSERT OR REPLACE INTO linked_roles (discord_role_id, discord_role_name, vrchat_role_id, vrchat_role_name, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(String(discordRoleId), String(discordRoleName || ''), String(vrchatRoleId), String(vrchatRoleName || ''), new Date().toISOString())
}

function removeLinkedRole(discordRoleId) {
  const db2 = getDb()
  db2.prepare('DELETE FROM role_state WHERE discord_role_id = ?').run(String(discordRoleId))
  return db2.prepare('DELETE FROM linked_roles WHERE discord_role_id = ?').run(String(discordRoleId)).changes > 0
}

function listLinkedRoles() {
  return getDb().prepare('SELECT * FROM linked_roles ORDER BY created_at').all()
}

// ---------------------------------------------------------------
// role state (for two-way diff sync)
// ---------------------------------------------------------------

function getRoleState(discordId, discordRoleId) {
  return getDb()
    .prepare('SELECT * FROM role_state WHERE discord_id = ? AND discord_role_id = ?')
    .get(String(discordId), String(discordRoleId)) || null
}

function setRoleState(discordId, discordRoleId, hadDiscord, hadVrchat) {
  getDb()
    .prepare('INSERT OR REPLACE INTO role_state (discord_id, discord_role_id, had_discord, had_vrchat, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(String(discordId), String(discordRoleId), hadDiscord ? 1 : 0, hadVrchat ? 1 : 0, new Date().toISOString())
}

// ---------------------------------------------------------------
// trackers
// ---------------------------------------------------------------

function addTracker(channelId, stat, label) {
  getDb()
    .prepare('INSERT OR REPLACE INTO trackers (channel_id, stat, label, created_at) VALUES (?, ?, ?, ?)')
    .run(String(channelId), String(stat), String(label), new Date().toISOString())
}

function removeTracker(channelId) {
  return getDb().prepare('DELETE FROM trackers WHERE channel_id = ?').run(String(channelId)).changes > 0
}

function listTrackers() {
  return getDb().prepare('SELECT * FROM trackers').all()
}

function updateTracker(channelId, value, renamedAt) {
  getDb()
    .prepare('UPDATE trackers SET last_value = ?, last_renamed_at = ? WHERE channel_id = ?')
    .run(String(value), Number(renamedAt), String(channelId))
}

// ---------------------------------------------------------------
// misc roles
// ---------------------------------------------------------------

function setMiscRole(key, discordRoleId) {
  getDb()
    .prepare('INSERT OR REPLACE INTO misc_roles (key, discord_role_id, created_at) VALUES (?, ?, ?)')
    .run(String(key), String(discordRoleId), new Date().toISOString())
}

function getMiscRoles() {
  const map = {}
  for (const row of getDb().prepare('SELECT * FROM misc_roles').all()) {
    map[row.key] = row.discord_role_id
  }
  return map
}

// ---------------------------------------------------------------
// key/value store
// ---------------------------------------------------------------

function getKv(key, fallback = null) {
  const row = getDb().prepare('SELECT value FROM kv WHERE key = ?').get(String(key))
  if (!row) return fallback
  try {
    return JSON.parse(row.value)
  } catch {
    return fallback
  }
}

function setKv(key, value) {
  getDb()
    .prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)')
    .run(String(key), JSON.stringify(value))
}

// ---------------------------------------------------------------
// moderation logs
// ---------------------------------------------------------------

function saveModerationLog({ logId, auditId, eventType, targetId, targetName, actorName, location, occurredAt, channelId, messageId }) {
  getDb()
    .prepare(`INSERT OR REPLACE INTO moderation_logs
      (log_id, audit_id, event_type, target_id, target_name, actor_name, location, occurred_at, channel_id, message_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      String(logId), String(auditId || ''), String(eventType || ''), String(targetId || ''),
      String(targetName || ''), String(actorName || ''), String(location || ''),
      String(occurredAt || ''), String(channelId || ''), String(messageId || ''),
      new Date().toISOString()
    )
}

function getModerationLog(logId) {
  return getDb().prepare('SELECT * FROM moderation_logs WHERE log_id = ?').get(String(logId)) || null
}

function setModerationReason(logId, reason, byDiscordId) {
  getDb()
    .prepare('UPDATE moderation_logs SET reason = ?, reason_by = ? WHERE log_id = ?')
    .run(String(reason), String(byDiscordId), String(logId))
}

function setModerationBanRequested(logId, byDiscordId) {
  getDb()
    .prepare('UPDATE moderation_logs SET ban_requested_by = ? WHERE log_id = ?')
    .run(String(byDiscordId), String(logId))
}

module.exports = {
  getDb,
  getLinkByDiscord,
  getLinkByVrchat,
  listLinks,
  createLink,
  deleteLink,
  saveLinkCode,
  getLinkCode,
  deleteLinkCode,
  purgeExpiredCodes,
  setLinkedRole,
  removeLinkedRole,
  listLinkedRoles,
  getRoleState,
  setRoleState,
  addTracker,
  removeTracker,
  listTrackers,
  updateTracker,
  setMiscRole,
  getMiscRoles,
  getKv,
  setKv,
  saveModerationLog,
  getModerationLog,
  setModerationReason,
  setModerationBanRequested,
}
