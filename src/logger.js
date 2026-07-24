'use strict'

// Logging for VRChat-Discord Group Link. Grown from the VRChat Legends API
// startup logger into a proper leveled logger: timestamps, colors, scoped
// prefixes, daily log files, and a startup summary that never prints secrets.

const fs = require('fs')
const path = require('path')
const config = require('./config')

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 }
const COLORS = {
  error: '\u001b[31m', // red
  warn: '\u001b[33m',  // yellow
  info: '\u001b[36m',  // cyan
  debug: '\u001b[90m', // gray
  reset: '\u001b[0m',
  dim: '\u001b[2m',
}

const activeLevel = LEVELS[config.log.level] ?? LEVELS.info
const useColor = process.stdout.isTTY

let fileStream = null
let fileDay = ''

function fileFor(now) {
  return path.join(config.log.dir, `${now.toISOString().slice(0, 10)}.log`)
}

function getFileStream(now) {
  if (!config.log.toFile) return null
  const day = now.toISOString().slice(0, 10)
  if (fileStream && day === fileDay) return fileStream
  try {
    fs.mkdirSync(config.log.dir, { recursive: true })
    if (fileStream) fileStream.end()
    fileStream = fs.createWriteStream(fileFor(now), { flags: 'a' })
    fileDay = day
    pruneOldLogs()
    return fileStream
  } catch {
    return null
  }
}

// Keep two weeks of log files.
function pruneOldLogs() {
  try {
    const files = fs.readdirSync(config.log.dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.log$/.test(f)).sort()
    while (files.length > 14) {
      fs.unlinkSync(path.join(config.log.dir, files.shift()))
    }
  } catch {
    /* best effort */
  }
}

function fmt(value) {
  if (value instanceof Error) return value.stack || value.message
  if (typeof value === 'object' && value !== null) {
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  return String(value)
}

function write(level, scope, args) {
  if (LEVELS[level] > activeLevel) return
  const now = new Date()
  const time = now.toISOString().replace('T', ' ').slice(0, 19)
  const text = args.map(fmt).join(' ')
  const line = `${time} ${level.toUpperCase().padEnd(5)} [${scope}] ${text}`

  if (useColor) {
    const color = COLORS[level] || ''
    console.log(`${COLORS.dim}${time}${COLORS.reset} ${color}${level.toUpperCase().padEnd(5)}${COLORS.reset} ${COLORS.dim}[${scope}]${COLORS.reset} ${text}`)
  } else {
    console.log(line)
  }

  const stream = getFileStream(now)
  if (stream) stream.write(`${line}\n`)
}

/**
 * Create a scoped logger: const log = logger('VRChat')
 * log.info('hello'), log.warn(...), log.error(...), log.debug(...)
 */
function logger(scope) {
  return {
    error: (...args) => write('error', scope, args),
    warn: (...args) => write('warn', scope, args),
    info: (...args) => write('info', scope, args),
    debug: (...args) => write('debug', scope, args),
  }
}

// Startup summary: what is configured, without ever printing a secret.
function logStartup() {
  const log = logger('Startup')
  const d = config.discord
  const v = config.vrchat
  let cookieFile = false
  try {
    cookieFile = fs.existsSync(v.cookiePath)
  } catch {
    /* ignore */
  }

  log.info('--- VRChat-Discord Group Link - startup ---')
  log.info(`Discord token: ${d.token ? 'set' : 'MISSING'}`)
  log.info(`Discord guild: ${d.guildId || 'MISSING'}`)
  log.info(`VRChat group: ${v.groupId || 'MISSING'}`)
  log.info(`VRChat credentials: ${v.email && v.password ? 'email+password set' : 'incomplete'}${v.totpSecret ? ' + TOTP' : ''}`)
  log.info(`VRChat manual cookie: ${v.authCookie ? 'set' : 'not set'}`)
  log.info(`VRChat cookie file: ${cookieFile ? 'present' : 'absent (login on first API call)'}`)
  log.info(`Sync interval: ${config.sync.intervalSeconds}s`)
  log.info(`API pacing: ${v.apiMinIntervalMs}ms gap, ${v.maxRequestsPerMinute}/min cap`)
  log.info(`Log level: ${config.log.level}${config.log.toFile ? ' (also writing data/logs/)' : ''}`)
  log.info('Tip: enable the Server Members Intent on the Discord bot page.')
  log.info('-------------------------------------------')
}

module.exports = logger
module.exports.logStartup = logStartup
