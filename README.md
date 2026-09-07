# VRChat-Discord Group Link

A self-hosted Discord bot by [VRChat Legends](https://vrchatlegends.com) that links Discord members to their VRChat accounts and keeps your Discord roles and your VRChat group roles in sync, both ways, automatically.

No website, no database server, no cloud. One folder, one .env, run.bat.

## What it does

- **Account linking**: members run `/link`, set their VRChat **status message** to a one time code, and the bot verifies it (capitalization, spaces, and the dash do not matter). Codes expire after 15 minutes (shown as a live Discord countdown). Ambiguous names get an account picker, so nobody ever links the wrong profile. `/link-panel` posts a permanent button so a verify channel needs no commands at all. Admins can also link someone by hand with `/force-link`.
- **Two way role sync**: link any Discord role to any VRChat group role. Gain or lose the role on either platform and the bot mirrors it to the other one. Every linked member is checked on every pass, not a handful at a time, and a role change made in VRChat is picked up from the group audit log within seconds.
- **Profile roles**: `/setup-misc-roles` creates 18+, VRC+, all five trust rank roles (Visitor through Trusted User), a Repping Legends role for members representing the group, and tenure roles for 1 month, 6 months, and 1 year in the group. Linked members get them automatically from their live VRChat profile and group membership.
- **Stat tracker channels**: locked voice channels that display live numbers, like `Group Members: 1234`.
- **Log channels**: optional Discord channels that receive embeds for links, unlinks, every role change the bot makes, and alerts. `/setup-log-channels` builds the whole set in one go and fills `config.yml` for you.
- **Group audit log feed**: the bot watches your VRChat group's audit log and posts an embed for every event: warns, kicks, bans, unbans, joins, leaves, join requests, invites, role changes, posts, instances, and settings changes. Each category can go to its own channel (set in `config.yml`), with a default channel catching the rest. Linked members show up with their Discord account right in the embed.
- **Moderation controls**: warn, kick, and ban logs come with a 25 option reason menu, a Custom Reason button (type your own), a Request Ban button that posts a pre-filled moderation template to the alert channel, and live **Ban in VRChat**, **Kick from Group**, and **Unban** buttons that act on the group for real (admin only, always behind a confirmation). No emojis are used, so you can add your own custom ones later.
- **Case threads**: every actionable log opens its own thread, seeded with the staff action template, so evidence and discussion stay attached to the incident. Turn it off with `moderation.case_threads` in `config.yml`.
- **Group post feed**: new group posts and announcements are mirrored into Discord, image and all.
- **Join request queue**: pending group join requests are posted with Accept, Deny, and Deny and Block buttons, so applications get handled from Discord.
- **Member lookup**: `/get-member-info` builds an embed with everything the API knows about a user, including their group join date, whether they are representing the group, and staff manager notes. Right click any Discord member and pick **Apps, VRChat Profile** for the same card.
- **Membership audit**: `/audit-members` walks the entire group and reports linked members who left, banned users who still have a Discord link, and group members who never linked, with a full text file attached. `/unlinked` does the Discord side: who in the server never linked at all.
- **Moderation logs that point at people**: warn, kick, and ban entries ping the staff member who did it (when their Discord is linked), name the member it was against next to the user id, and show that member's VRChat avatar. Who may press the ban, kick, and unban buttons is set by `moderation.admin_role_ids` and `moderation.admin_user_ids`.
- **Group management from Discord**: `/vrc-invite` sends a group invite, `/vrc-post` writes a group post or announcement (members only or public, with an optional notification), and `/vrc-role-members` lists everyone holding a group role next to their Discord account.
- **Rate limit safe**: every VRChat API call is globally paced (default 1 per second, 30 per minute). The member list is read in bulk, one call per 100 members, and cached, so checking everybody costs a handful of calls instead of one per member. The bot will never hammer the VRChat API.

## Simple mode

Set `simple_mode: true` in `config.yml` and restart to run the bot as a plain log relay. It keeps posting group audit logs, group posts, and join requests, and it keeps the stat trackers, but nothing is clickable and nothing is linked: no `/link`, no profile roles, no role sync, no ban, kick, or unban buttons, no reason picker, and no case threads. Only `/get-member-info`, `/group-info`, `/setup-log-channels`, `/track`, `/ping`, and `/help` get registered. Set it back to `false` and restart to turn everything on again.

## Commands
| Command | Who | What |
| --- | --- | --- |
| `/link vrchat_user:<name or usr_ id>` | Everyone | Start linking. Exact display names go straight to a status code; fuzzy matches show a picker so you always link the right account. Run it while linked and it asks you to `/unlink` first. |
| `/unlink` | Everyone | Remove your link. Bot managed profile roles are taken back. |
| `/whois [member]` | Everyone | Which VRChat account a member is linked to, whether they are in the group, their trust rank, and the roles the bot gave them. |
| `/group-info` | Everyone | Live group numbers: members, who is in an instance right now, join type, and when it was created. |
| `/set-linked-role discord_role vrchat_role` | Admin | Pair a Discord role with a VRChat group role (autocomplete pulls the live role list from your group). |
| `/remove-linked-role discord_role` | Admin | Remove a pair. Existing roles stay; they just stop syncing. |
| `/list-linked-roles` | Admin | Show every pair. |
| `/track stat name` | Admin | Create a locked voice channel showing `name: number`. Stats: group members, users in instances, open instances, linked members. Delete the channel to remove the tracker. |
| `/get-member-info user` | Admin | Full profile embed: trust rank, VRC+, 18+, status, group roles, group join date, representing, manager notes, bio, links, and more. |
| `VRChat Profile` (right click a member, Apps) | Everyone | The same profile card for that member's linked VRChat account. |
| `/force-link member vrchat_user` | Admin | Link someone yourself, skipping the status code step. Logged to the alert channel. |
| `/force-unlink member` | Admin | Remove someone else's link and take back the roles it granted. |
| `/links [query]` | Admin | Browse every link with paging, and filter by VRChat name or id. |
| `/unlinked [role]` | Admin | Everyone in the server with no VRChat link, optionally narrowed to one role, with a coverage percentage. |
| `/sync-status` | Admin | Last pass, members checked, roster age and size, event queue depth, and anything blocking the sync. |
| `/vrc-search query` | Admin | Search the VRChat group member list by name (three characters or more). Shows join date, representing, notes, and the Discord link. |
| `/vrc-role-members vrchat_role` | Admin | Everyone holding a VRChat group role and who they are on Discord. |
| `/vrc-invite user` | Admin | Send a VRChat group invite. |
| `/vrc-post title text [visibility] [notify]` | Admin | Create a group post, for members only or public, with an optional notification. |
| `/vrc-ban user [reason]` | Admin | Ban someone from the VRChat group. The reason is kept in the Discord alert log (VRChat has no reason field). |
| `/vrc-kick user [reason]` | Admin | Remove someone from the group. They can request to join again. |
| `/vrc-unban user [reason]` | Admin | Lift a group ban. Paste the `usr_` id if the name will not resolve. |
| `/vrc-bans` | Admin | Browse the group ban list, ten at a time, with Previous and Next. |
| `/audit-members` | Admin | Cross check every group member against the Discord links and the ban list. Takes a couple of minutes on a big group. |
| `/recheck-roles [member]` | Admin | Force a pass now, for one member or everyone, and report anything blocking the roles. |
| `/link-panel [channel] [title] [message]` | Admin | Post a permanent embed with a Link my VRChat button. Members press it, type their name in a popup, and get their code. |
| `/setup-misc-roles` | Admin | Create or adopt the 18+, VRC+, trust rank, repping, and tenure roles. |
| `/setup-log-channels category` | Admin | Creates all twelve log and feed channels inside the category you pick (hidden from @everyone), writes every channel ID into `config.yml`, and starts the feeds immediately. Safe to re-run; existing channels are kept. |
| `/ping` | Everyone | Latency, VRChat auth status, link counts. |
| `/help` | Everyone | Everything the bot does, showing only the commands you are allowed to use. |

## Setup

### 1. Create the Discord bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) and create a **New Application**.
2. On the **Bot** page: copy the **Token**, and enable the **Server Members Intent**.
3. Invite the bot to your server with this URL (replace `YOUR_APP_ID`):

```
https://discord.com/oauth2/authorize?client_id=YOUR_APP_ID&scope=bot%20applications.commands&permissions=268438544
```

That permission number grants: Manage Roles, Manage Channels, View Channels, Send Messages. Put the bot's role **above** every role you want it to hand out.

### 2. Get a VRChat account for the bot

Use a dedicated VRChat account that has group permissions to **manage member roles** and to **view all members** (the member list is what lets the bot check everybody cheaply). For the ban, kick, and unban features it also needs **Moderate Group Members** (remove members and manage bans). Enable 2FA with an authenticator app and keep the base32 secret it shows you; the bot logs in with email, password, and that TOTP secret, then reuses the session cookie so it rarely logs in again.

### 3. Install and configure

Requirements: [Node.js 22.5+](https://nodejs.org) on Windows (or any OS; the .bat files are Windows convenience).

1. Run `setup.bat` (installs dependencies and creates your `.env`).
2. Open `.env` and fill in:
   - `DISCORD_TOKEN` and `DISCORD_GUILD_ID`
   - `VRCHAT_GROUP_ID` (from your group page URL, `grp_...`)
   - `VRCHAT_EMAIL`, `VRCHAT_PASSWORD`, `VRCHAT_TOTP_SECRET`
3. Optional: open `config.yml` and set the log channel IDs (link log, role log, alert log), the group audit log channels (warn, kick, ban, join, and friends), and the rich presence rotation. Or skip the IDs entirely and run `/setup-log-channels` once the bot is in your server.
4. Run `run.bat`. Watch the log for `Gateway ready as ...` and `Session established`.

On other platforms: `npm install` then `npm start`.

### 4. In Discord

1. `/setup-misc-roles` once. Re-run it after updating the bot so new profile roles (repping, tenure) get created.
2. `/setup-log-channels` once, pointing at a staff category.
3. `/set-linked-role` for each Discord role you want mirrored to a VRChat group role.
4. `/track` any stats you want on display.
5. `/link-panel` in your verify channel, then tell members to press the button (or run `/link`).

## How the sync works

Three things move roles, and they cover each other:

- **Discord to VRChat, instantly.** A role change on Discord arrives as a gateway event and is pushed to the VRChat group straight away. The bot ignores the echo of its own writes, so nothing loops.
- **VRChat to Discord, within a poll.** The group audit log is read every `group_logs.poll_seconds` (default 60). Role assignments, joins, leaves, kicks, and bans queue that member for an immediate check, so a role handed out in VRChat lands in Discord seconds later.
- **A full pass every `SYNC_INTERVAL_SECONDS`** (default 300) as the safety net. It checks **every** linked member, not a rotating handful. That is affordable because the whole group member list is read in bulk (one VRChat call per 100 members) and cached for `sync.roster_refresh_seconds`, and because trust rank, VRC+, and 18+ are cached per member and refreshed on a slow rotation. The per-member part of a pass costs zero VRChat calls.

Per member and per linked pair the bot stores the last state of both sides. Whichever side changed gets mirrored; if both changed against each other in the same window, `sync.conflict_winner` decides (Discord by default). The first time it sees a member, and again the first time they show up in the group, holding the role on either side grants it on the other, so somebody who linked before joining still gets everything when they join.

Safety rules it will not break:

- Membership has to be **known** before linked roles are touched. A failed lookup means unknown, never "left the group", so a network blip can never strip anything.
- Somebody missing from the cached member list is confirmed with a direct lookup before any role comes off, because paging a live list can skip a row.
- Roles the bot does not manage are never touched, even when several changes are applied in one write.
- If the member list cannot be read at all, the bot says so in the alert channel and falls back to checking a few members per pass rather than stalling.

Tracker channels rename at most once every 6 minutes per channel because Discord itself limits channel renames to about 2 per 10 minutes.

### Tuning

Everything above is adjustable in the `sync` section of `config.yml`: `roster_refresh_seconds`, `roster_max_members`, `profiles_per_cycle`, `profile_ttl_hours`, `event_drain_seconds`, `conflict_winner`, and `grant_on_first_sight`. The defaults suit groups up to about 25,000 members. Run `/sync-status` to see what the engine is actually doing before changing any of them.

## Troubleshooting

- **"You're not allowed to change a member of the same or higher rank" (HTTP 403)**: VRChat only lets an account edit members **below** its own highest group role; the bot having Discord admin changes nothing. In the VRChat group settings, move the bot account's role above the roles of everyone it should manage and give that role **Manage Group Member Data**. The bot pauses role edits for an affected member for 6 hours and posts one alert instead of spamming. The same rule applies to the ban and kick buttons.
- **Roles are not being handed out**: run `/sync-status` first, it names the cause. The usual ones are that `/setup-misc-roles` was never run, or that the bot's Discord role sits **below** the roles it hands out (Server Settings, Roles). The bot rechecks this on startup and every hour and posts one alert to the alert log; `/recheck-roles` runs the same check on demand.
- **"I cannot read the group member list"**: the bot's VRChat account needs a group role that can view all members. Without it the bot falls back to checking a few members per pass, so role changes take much longer to appear.
- **A VRChat role change is not showing up in Discord**: the fast path comes from the group audit log, so the bot needs to be able to read it. Check `/sync-status` for the event queue and the last pass. Even with no audit log channels configured the bot still polls it for the sync.
- **Ban or kick buttons do nothing**: `moderation.allow_actions_from_discord` in `config.yml` must be true, and you must be on the moderator list. Set `moderation.admin_role_ids` and `moderation.admin_user_ids` in `config.yml` to control exactly who can ban, kick, and unban; leave both empty and it falls back to anyone with Administrator.

## Data and logs

- Everything lives in `data/`: `group-link.sqlite` (links, pairs, trackers, cached profile facts), `vrchat_cookies.json` (session), and `logs/` (daily files, two weeks kept).
- Secrets stay in `.env`; non-secret settings (log channels, sync tuning, presence) live in `config.yml`.
- Logs never contain passwords, tokens, or cookies.
- Delete `data/vrchat_cookies.json` to force a fresh VRChat login.
- `npm test` runs the whole offline suite: the role sync engine, the roster and event queue, simple mode, the admin UI, and both setup dry runs. Nothing is ever changed in VRChat.
- `test/sync-two-way.js` covers the sync paths that matter, including the ones that must never strip a role.
- `test/roster-and-queue.js` covers member list paging, the failure path that keeps the old cache, and queue de-duplication.
- `test/simulate-link.js` runs the whole /link flow against the real VRChat API with mock Discord objects (needs VRChat credentials in the environment).
- `test/simulate-admin-ui.js` exercises the moderation buttons, the link panel, and the profile context menu offline, so nothing is ever changed in VRChat.
- `test/setup-log-channels-dryrun.js` runs `/setup-log-channels` against a mock guild and restores `config.yml` afterwards.

## Credits

Built by VRChat Legends. The VRChat auth and rate limiting layers are battle tested code carried over from the VRChat Legends website backend.

Not affiliated with VRChat Inc. Be a good API citizen: keep the default pacing unless you know exactly what you are doing.
