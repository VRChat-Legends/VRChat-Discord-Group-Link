'use strict'

// VRChat authentication: email + password + TOTP login with persistent
// session cookies and hard rate limiting. Copied from the VRChat Legends API
// backend (services/vrchat.js) and trimmed for this standalone bot.
// Never log cookies or auth headers.

const fs = require('fs')
const path = require('path')
const { request } = require('undici')
const { TOTP, NobleCryptoPlugin, ScureBase32Plugin } = require('otplib')
const config = require('./config')
const logger = require('./logger')

const log = logger('VRChat')

const VRCHAT_API = 'https://api.vrchat.cloud/api/1'
const UA = 'VRChatDiscordGroupLink/1.0 vrchatlegends.com'

// ---------------------------------------------------------------
// rate limiting: minimum gap between calls plus a per-minute cap.
// Every single VRChat API call in this bot goes through throttle().
// ---------------------------------------------------------------

let lastCallAt = 0
const callTimestamps = []

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function throttle() {
  const minInterval = config.vrchat.apiMinIntervalMs
  const maxPerMin = config.vrchat.maxRequestsPerMinute

  const now = Date.now()
  const windowStart = now - 60_000
  while (callTimestamps.length > 0 && callTimestamps[0] < windowStart) {
    callTimestamps.shift()
  }
  if (callTimestamps.length >= maxPerMin) {
    const wait = callTimestamps[0] + 60_000 - now + 50
    if (wait > 0) {
      log.debug(`Internal rate limit reached, waiting ${wait}ms`)
      await sleep(wait)
    }
    while (callTimestamps.length > 0 && callTimestamps[0] < Date.now() - 60_000) {
      callTimestamps.shift()
    }
  }

  const elapsed = Date.now() - lastCallAt
  if (elapsed < minInterval) await sleep(minInterval - elapsed)

  lastCallAt = Date.now()
  callTimestamps.push(lastCallAt)
}

async function throttledFetch(url, options = {}) {
  await throttle()
  return fetch(url, options)
}

// ---------------------------------------------------------------
// cookie persistence
// ---------------------------------------------------------------

function loadCookies() {
  try {
    if (fs.existsSync(config.vrchat.cookiePath)) {
      const parsed = JSON.parse(fs.readFileSync(config.vrchat.cookiePath, 'utf8'))
      return parsed.cookies || null
    }
  } catch (err) {
    log.warn('Failed to read cookie file:', err.message)
  }
  return null
}

function saveCookies(cookieString) {
  try {
    fs.mkdirSync(path.dirname(config.vrchat.cookiePath), { recursive: true })
    fs.writeFileSync(
      config.vrchat.cookiePath,
      JSON.stringify({ cookies: cookieString, savedAt: new Date().toISOString() }, null, 2),
      'utf8'
    )
    log.info('Session cookies persisted to disk.')
  } catch (err) {
    log.error('Failed to save cookies:', err.message)
  }
}

/** Merge Set-Cookie name=value pairs; later values win per name. */
function mergeCookieStrings(existing, incoming) {
  const map = new Map()
  const add = (chunk) => {
    for (const part of String(chunk || '')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean)) {
      const eq = part.indexOf('=')
      const name = eq >= 0 ? part.slice(0, eq).trim() : part
      map.set(name, part)
    }
  }
  add(existing)
  add(incoming)
  return Array.from(map.values()).join('; ')
}

function undiciSetCookieLine(headers) {
  const raw = headers['set-cookie']
  if (!raw) return ''
  const list = Array.isArray(raw) ? raw : [raw]
  return list.map((c) => String(c).split(';')[0]).join('; ')
}

async function drainUndiciBody(body) {
  try {
    if (typeof body.dump === 'function') await body.dump()
    else await body.text()
  } catch {
    /* ignore */
  }
}

/**
 * undici with maxRedirections:0 so each hop exposes Set-Cookie headers
 * (plain fetch() hides cookies set during redirects).
 */
async function followCollectingCookies(initialUrl, init, seedCookies = '') {
  let cookieString = seedCookies || ''
  let url = initialUrl
  let method = (init.method || 'GET').toUpperCase()
  let body = init.body
  let headers = { ...(init.headers || {}) }
  const maxHops = 15

  for (let hop = 0; hop < maxHops; hop++) {
    const outgoing = { ...headers }
    if (cookieString) outgoing.cookie = cookieString

    await throttle()
    const { statusCode, headers: resHeaders, body: resBody } = await request(url, {
      method,
      headers: outgoing,
      body: method === 'GET' || method === 'HEAD' ? null : body,
      maxRedirections: 0,
    })

    const added = undiciSetCookieLine(resHeaders)
    if (added) cookieString = mergeCookieStrings(cookieString, added)

    if (statusCode >= 300 && statusCode < 400) {
      const loc = resHeaders.location
      await drainUndiciBody(resBody)
      if (!loc) return { statusCode, cookieString, bodyText: '' }
      url = new URL(loc, url).href

      if (statusCode === 303 || ((statusCode === 301 || statusCode === 302) && method === 'POST')) {
        method = 'GET'
        body = null
        const h = { ...headers }
        delete h['content-type']
        headers = h
      } else if (statusCode !== 307 && statusCode !== 308) {
        method = 'GET'
        body = null
      }

      if (cookieString) {
        const h = { ...headers }
        delete h.authorization
        headers = h
      }
      continue
    }

    const bodyText = await resBody.text()
    return { statusCode, cookieString, bodyText }
  }

  throw new Error('Too many redirects during VRChat auth')
}

// ---------------------------------------------------------------
// login flow
// ---------------------------------------------------------------

// Returns 'valid' when the cookies work, 'invalid' when VRChat rejects
// them, and 'error' when the check itself failed (network trouble, 5xx).
// On 'error' we keep trusting the cookies instead of burning a password
// login; a real 401 later triggers refreshAuthCookies() anyway.
async function verifySession(cookieString) {
  if (!cookieString) return 'invalid'
  try {
    const res = await throttledFetch(`${VRCHAT_API}/auth/user`, {
      headers: { Cookie: cookieString, 'User-Agent': UA },
    })
    if (res.ok) {
      const body = await res.json()
      if (body && body.displayName && !body.requiresTwoFactorAuth) {
        log.info(`Session valid (logged in as ${body.displayName}).`)
        return 'valid'
      }
      return 'invalid'
    }
    if (res.status === 401 || res.status === 403) return 'invalid'
    return 'error'
  } catch (err) {
    log.warn('Session check failed (keeping saved cookies):', err.message)
    return 'error'
  }
}

async function fullLogin() {
  const { email, password, totpSecret } = config.vrchat
  if (!email || !password) return ''

  // Per VRChat API docs: base64(urlencode(username):urlencode(password))
  const credentials = Buffer.from(
    `${encodeURIComponent(email)}:${encodeURIComponent(password)}`
  ).toString('base64')

  const o = await followCollectingCookies(`${VRCHAT_API}/auth/user`, {
    method: 'GET',
    headers: {
      authorization: `Basic ${credentials}`,
      'user-agent': UA,
    },
  })

  if (o.statusCode !== 200) {
    log.warn('Login request returned HTTP', o.statusCode)
    return ''
  }

  let cookieString = o.cookieString || ''
  let loginBody
  try {
    loginBody = JSON.parse(o.bodyText || '{}')
  } catch {
    return ''
  }

  if (loginBody.requiresTwoFactorAuth) {
    if (!totpSecret) {
      throw new Error('TOTP required but VRCHAT_TOTP_SECRET is not set.')
    }
    const totp = new TOTP({ secret: totpSecret, crypto: new NobleCryptoPlugin(), base32: new ScureBase32Plugin() })
    const code = await totp.generate()
    log.info('Sending TOTP for 2FA verification...')
    const verify = await followCollectingCookies(
      `${VRCHAT_API}/auth/twofactorauth/totp/verify`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': UA },
        body: JSON.stringify({ code }),
      },
      cookieString
    )
    if (verify.statusCode !== 200) {
      log.warn('TOTP verification returned HTTP', verify.statusCode)
      return ''
    }
    cookieString = mergeCookieStrings(cookieString, verify.cookieString)
    log.info('TOTP 2FA verified.')
  }

  return cookieString
}

async function login() {
  const { email, password } = config.vrchat
  if (!email || !password) {
    log.warn('No VRChat credentials configured; cannot log in.')
    return null
  }
  log.info('Attempting fresh VRChat login...')
  const cookieString = await fullLogin()
  if (String(cookieString || '').trim()) {
    saveCookies(cookieString)
    log.info('VRChat session established.')
    return cookieString
  }
  log.warn('VRChat login failed: no session cookies obtained.')
  return null
}

// ---------------------------------------------------------------
// session state. Cookies are verified once per process, then trusted
// until VRChat rejects them with a 401. Full password logins are rate
// limited hard: VRChat treats every password login as a brand new session
// (email notification, login rate limit), so a broken credential state
// must never be able to hammer that endpoint.
// ---------------------------------------------------------------

let cachedCookies = null
let authPromise = null
let lastLoginAttemptAt = 0
const LOGIN_COOLDOWN_MS = 5 * 60 * 1000

async function loginWithCooldown() {
  const sinceLast = Date.now() - lastLoginAttemptAt
  if (sinceLast < LOGIN_COOLDOWN_MS) {
    const waitS = Math.ceil((LOGIN_COOLDOWN_MS - sinceLast) / 1000)
    log.warn(`VRChat login on cooldown for another ${waitS}s; not retrying yet.`)
    return null
  }
  lastLoginAttemptAt = Date.now()
  return login()
}

async function doGetAuthCookies() {
  // Try the freshest saved session first, then a manually provided cookie.
  const candidates = []
  const saved = loadCookies()
  if (saved) candidates.push(['Saved', saved])
  if (config.vrchat.authCookie) candidates.push(['VRCHAT_AUTH_COOKIE', config.vrchat.authCookie])

  for (const [label, cookies] of candidates) {
    const state = await verifySession(cookies)
    if (state === 'valid') return cookies
    // The check itself failed (network trouble): trust the cookies rather
    // than burning a password login. A real 401 later forces a refresh.
    if (state === 'error') return cookies
    log.info(`${label} session is expired or incomplete.`)
    // Drop the dead cookie file so later attempts skip straight to login
    // instead of re-checking known-bad cookies against the API.
    if (label === 'Saved') {
      try {
        fs.unlinkSync(config.vrchat.cookiePath)
      } catch { /* already gone */ }
    }
  }

  if (candidates.length) log.info('No usable saved session. Re-authenticating...')
  return loginWithCooldown()
}

/**
 * Returns the current session cookies. Verifies the saved session once per
 * process, then serves it from memory with no re-checks. Concurrent callers
 * share one in-flight attempt.
 */
function getAuthCookies() {
  if (cachedCookies) return Promise.resolve(cachedCookies)
  if (!authPromise) {
    authPromise = doGetAuthCookies()
      .then((cookies) => {
        if (cookies) cachedCookies = cookies
        return cookies
      })
      .finally(() => {
        authPromise = null
      })
  }
  return authPromise
}

/**
 * Called when VRChat rejected the current cookies (401): drop them and do
 * one full re-login. Single-flight and subject to the login cooldown, so
 * concurrent failures cannot stack login attempts.
 */
function refreshAuthCookies() {
  cachedCookies = null
  try {
    if (fs.existsSync(config.vrchat.cookiePath)) fs.unlinkSync(config.vrchat.cookiePath)
  } catch (err) {
    log.warn('Failed to remove stale cookie file:', err.message)
  }
  if (!authPromise) {
    authPromise = loginWithCooldown()
      .then((cookies) => {
        if (cookies) cachedCookies = cookies
        return cookies
      })
      .finally(() => {
        authPromise = null
      })
  }
  return authPromise
}

module.exports = {
  VRCHAT_API,
  UA,
  throttle,
  throttledFetch,
  getAuthCookies,
  refreshAuthCookies,
}
