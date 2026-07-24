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

async function verifySession(cookieString) {
  if (!cookieString) return false
  try {
    const res = await throttledFetch(`${VRCHAT_API}/auth/user`, {
      headers: { Cookie: cookieString, 'User-Agent': UA },
    })
    if (res.ok) {
      const body = await res.json()
      if (body && body.displayName && !body.requiresTwoFactorAuth) {
        log.info(`Session valid (logged in as ${body.displayName}).`)
        return true
      }
    }
  } catch (err) {
    log.warn('Session verification failed:', err.message)
  }
  return false
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

async function doGetAuthCookies() {
  const manual = config.vrchat.authCookie
  if (manual) {
    if (await verifySession(manual)) return manual
    log.warn('VRCHAT_AUTH_COOKIE invalid or expired; trying saved session.')
  }
  const existing = loadCookies()
  if (existing) {
    if (await verifySession(existing)) return existing
    log.info('Saved session expired. Re-authenticating...')
  }
  return login()
}

// In-memory cookie cache so we do not hit /auth/user on every call.
let cachedCookies = null
let cachedCookiesAt = 0
let authPromise = null
const COOKIE_CACHE_TTL = 10 * 60 * 1000

function getAuthCookies({ force = false } = {}) {
  if (!force && cachedCookies && Date.now() - cachedCookiesAt < COOKIE_CACHE_TTL) {
    return Promise.resolve(cachedCookies)
  }
  if (!authPromise) {
    authPromise = doGetAuthCookies()
      .then((cookies) => {
        if (cookies) {
          cachedCookies = cookies
          cachedCookiesAt = Date.now()
        }
        return cookies
      })
      .finally(() => {
        authPromise = null
      })
  }
  return authPromise
}

// Drop cached + on-disk session so the next call forces a full re-login.
function invalidateAuthCookies() {
  cachedCookies = null
  cachedCookiesAt = 0
  try {
    if (fs.existsSync(config.vrchat.cookiePath)) fs.unlinkSync(config.vrchat.cookiePath)
  } catch (err) {
    log.warn('Failed to remove stale cookie file:', err.message)
  }
}

module.exports = {
  VRCHAT_API,
  UA,
  throttle,
  throttledFetch,
  getAuthCookies,
  invalidateAuthCookies,
}
