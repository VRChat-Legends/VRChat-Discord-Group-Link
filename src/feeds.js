'use strict'

// Extra VRChat group feeds: new group posts and announcements mirrored to
// Discord, and pending join requests posted with Accept and Deny buttons.
// Both share one slow poll (default 5 minutes, 2 API calls per tick) so the
// VRChat rate limit is never a concern.

const config = require('./config')
const logger = require('./logger')
const db = require('./db')
const vrc = require('./vrchatApi')

const log = logger('Feeds')

const KV_SEEN_POSTS = 'feed_seen_posts'
const KV_SEEN_REQUESTS = 'feed_seen_requests'
const SEEN_CAP = 200
const POST_COLOR = 0x26a269
const REQUEST_COLOR = 0x62a0ea

let clientRef = null
let pollTimer = null
let polling = false

async function sendTo(channelId, payload) {
  if (!clientRef || !channelId) return null
  const channel = clientRef.channels.cache.get(channelId)
    || await clientRef.channels.fetch(channelId).catch(() => null)
  if (!channel || !channel.isTextBased?.()) {
    log.warn(`Feed channel ${channelId} is missing or not a text channel`)
    return null
  }
  return channel.send({ ...payload, allowedMentions: { parse: [] } })
}

function unix(dateish) {
  const ms = Date.parse(dateish || '')
  return Math.floor((Number.isFinite(ms) ? ms : Date.now()) / 1000)
}

async function authorLine(userId) {
  if (!userId) return 'Unknown'
  let name = userId
  try {
    const user = await vrc.getUser(userId)
    if (user?.displayName) name = user.displayName
  } catch { /* id is enough */ }
  const link = db.getLinkByVrchat(userId)
  return `[${name}](https://vrchat.com/home/user/${userId})${link ? ` | <@${link.discord_id}>` : ''}`
}

// ---------------------------------------------------------------
// group posts and announcements
// ---------------------------------------------------------------

async function pollPosts() {
  const channelId = config.feeds.postsChannelId
  if (!channelId) return

  const seen = new Set(db.getKv(KV_SEEN_POSTS, []))
  const { posts } = await vrc.getGroupPosts({ n: 10 })
  const announcement = await vrc.getGroupAnnouncement().catch(() => null)

  const items = [...posts]
  if (announcement && !items.some((p) => p.id === announcement.id)) items.push({ ...announcement, isAnnouncement: true })

  // Oldest first so Discord reads in order.
  items.sort((a, b) => unix(a.createdAt) - unix(b.createdAt))

  let posted = 0
  for (const post of items) {
    if (!post?.id || seen.has(post.id)) continue

    const isAnnouncement = Boolean(post.isAnnouncement) || post.id === announcement?.id
    const embed = {
      title: (post.title ? String(post.title) : (isAnnouncement ? 'Group Announcement' : 'Group Post')).slice(0, 256),
      color: POST_COLOR,
      description: String(post.text || '').slice(0, 4000) || undefined,
      fields: [
        { name: 'Author', value: (await authorLine(post.authorId)).slice(0, 1024), inline: true },
        { name: 'Posted', value: `<t:${unix(post.createdAt)}:F>`, inline: true },
      ],
      image: post.imageUrl ? { url: post.imageUrl } : undefined,
      footer: { text: isAnnouncement ? 'VRChat group announcement' : 'VRChat group post' },
      timestamp: new Date(post.createdAt || Date.now()).toISOString(),
    }
    await sendTo(channelId, { embeds: [embed] })
    seen.add(post.id)
    posted += 1
  }

  if (posted) {
    db.setKv(KV_SEEN_POSTS, [...seen].slice(-SEEN_CAP))
    log.info(`Mirrored ${posted} group post${posted === 1 ? '' : 's'}`)
  }
}

// ---------------------------------------------------------------
// join requests
// ---------------------------------------------------------------

function requestComponents(userId) {
  return [{
    type: 1,
    components: [
      { type: 2, style: 3, custom_id: `jr_accept:${userId}`, label: 'Accept' },
      { type: 2, style: 4, custom_id: `jr_deny:${userId}`, label: 'Deny' },
      { type: 2, style: 2, custom_id: `jr_block:${userId}`, label: 'Deny and Block' },
    ],
  }]
}

async function pollJoinRequests() {
  const channelId = config.feeds.joinRequestsChannelId
  if (!channelId) return

  const seen = new Set(db.getKv(KV_SEEN_REQUESTS, []))
  const requests = await vrc.getJoinRequests({ n: 50 })

  let posted = 0
  for (const req of requests) {
    const userId = req?.userId || req?.user?.id
    if (!userId || seen.has(userId)) continue

    const name = req?.user?.displayName || userId
    const link = db.getLinkByVrchat(userId)
    const embed = {
      title: 'Group Join Request',
      color: REQUEST_COLOR,
      fields: [
        { name: 'User', value: `[${name}](https://vrchat.com/home/user/${userId})`, inline: false },
        { name: 'User ID', value: `\`${userId}\``, inline: false },
        { name: 'Discord link', value: link ? `<@${link.discord_id}>` : 'Not linked', inline: true },
        { name: 'Requested', value: `<t:${unix(req?.createdAt)}:F>`, inline: true },
      ],
      footer: { text: 'Accept or deny below' },
      timestamp: new Date().toISOString(),
    }
    // Simple mode posts the request as a plain notice with no buttons.
    const components = config.simpleMode ? [] : requestComponents(userId)
    await sendTo(channelId, { embeds: [embed], components })
    seen.add(userId)
    posted += 1
  }

  if (posted) {
    db.setKv(KV_SEEN_REQUESTS, [...seen].slice(-SEEN_CAP))
    log.info(`Posted ${posted} join request${posted === 1 ? '' : 's'}`)
  }
}

// ---------------------------------------------------------------
// polling
// ---------------------------------------------------------------

async function poll() {
  if (polling) return
  polling = true
  try {
    await pollPosts()
  } catch (err) {
    log.warn('post feed failed:', err.message)
  }
  try {
    await pollJoinRequests()
  } catch (err) {
    log.warn('join request feed failed:', err.message)
  }
  polling = false
}

function enabled() {
  return Boolean(config.feeds.postsChannelId || config.feeds.joinRequestsChannelId)
}

function start(client) {
  clientRef = client
  if (pollTimer) return
  if (!enabled()) {
    log.info('No feed channels set in config.yml; post and join request feeds disabled.')
    return
  }

  // First run: remember what already exists so we do not replay history.
  if (!db.getKv(KV_SEEN_POSTS, null)) {
    vrc.getGroupPosts({ n: 10 })
      .then(({ posts }) => db.setKv(KV_SEEN_POSTS, posts.map((p) => p.id).filter(Boolean)))
      .catch(() => db.setKv(KV_SEEN_POSTS, []))
  }

  log.info(`Group post and join request feeds on, polling every ${config.feeds.pollSeconds}s.`)
  pollTimer = setInterval(poll, config.feeds.pollSeconds * 1000)
  pollTimer.unref?.()
  setTimeout(poll, 10_000).unref?.()
}

function stop() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

module.exports = { start, stop, poll, requestComponents }
