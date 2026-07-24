# VRChat-Discord Group Link

A self-hosted Discord bot by [VRChat Legends](https://vrchatlegends.com) that links Discord members to their VRChat accounts and keeps your Discord roles and your VRChat group roles in sync, both ways, automatically.

No website, no database server, no cloud. One folder, one .env, run.bat.

## What it does

- **Account linking**: members run `/link`, put a one time code in their VRChat bio, and the bot verifies it. Codes expire after 15 minutes (shown as a live Discord countdown). Ambiguous names get an account picker, so nobody ever links the wrong profile.
- **Two way role sync**: link any Discord role to any VRChat group role. Gain or lose the role on either platform and the bot mirrors it to the other one.
- **Profile roles**: `/setup-misc-roles` creates 18+, VRC+, and all five trust rank roles (Visitor through Trusted User). Linked members get them automatically from their live VRChat profile.
- **Stat tracker channels**: locked voice channels that display live numbers, like `Group Members: 1234`.
- **Log channels**: optional Discord channels that receive embeds for links, unlinks, every role change the bot makes, and alerts.
- **Member lookup**: `/get-member-info` builds an embed with everything the API knows about a user.
- **Rate limit safe**: every VRChat API call is globally paced (default 1 per second, 30 per minute) and big member lists sync in small rotating batches. The bot will never hammer the VRChat API.

## Commands

| Command | Who | What |
| --- | --- | --- |
| `/link vrchat_user:<name or usr_ id>` | Everyone | Start linking. Exact display names go straight to a bio code; fuzzy matches show a picker so you always link the right account. Run it while linked and it asks you to `/unlink` first. |
| `/unlink` | Everyone | Remove your link. Bot managed profile roles are taken back. |
| `/set-linked-role discord_role vrchat_role` | Admin | Pair a Discord role with a VRChat group role (autocomplete pulls the live role list from your group). |
| `/remove-linked-role discord_role` | Admin | Remove a pair. Existing roles stay; they just stop syncing. |
| `/list-linked-roles` | Admin | Show every pair. |
| `/track stat name` | Admin | Create a locked voice channel showing `name: number`. Stats: group members, users in instances, open instances. Delete the channel to remove the tracker. |
| `/get-member-info user` | Admin | Full profile embed: trust rank, VRC+, 18+, status, group roles, bio, links, join date, and more. |
| `/setup-misc-roles` | Admin | Create or adopt the 18+, VRC+, and trust rank roles. |
| `/ping` | Everyone | Latency, VRChat auth status, link counts. |

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

Use a dedicated VRChat account that has group permissions to **manage member roles**. Enable 2FA with an authenticator app and keep the base32 secret it shows you; the bot logs in with email, password, and that TOTP secret, then reuses the session cookie so it rarely logs in again.

### 3. Install and configure

Requirements: [Node.js 22.5+](https://nodejs.org) on Windows (or any OS; the .bat files are Windows convenience).

1. Run `setup.bat` (installs dependencies and creates your `.env`).
2. Open `.env` and fill in:
   - `DISCORD_TOKEN` and `DISCORD_GUILD_ID`
   - `VRCHAT_GROUP_ID` (from your group page URL, `grp_...`)
   - `VRCHAT_EMAIL`, `VRCHAT_PASSWORD`, `VRCHAT_TOTP_SECRET`
3. Optional: open `config.yml` and set the log channel IDs (link log, role log, alert log) and the rich presence rotation.
4. Run `run.bat`. Watch the log for `Gateway ready as ...` and `Session established`.

On other platforms: `npm install` then `npm start`.

### 4. In Discord

1. `/setup-misc-roles` once.
2. `/set-linked-role` for each Discord role you want mirrored to a VRChat group role.
3. `/track` any stats you want on display.
4. Tell members to `/link`.

## How the sync works

- A full pass runs every `SYNC_INTERVAL_SECONDS` (default 300). Each pass checks tracker stats and a rotating batch of 10 linked members (two API calls each), so even large communities cycle through everyone without bursts.
- Discord role changes are also mirrored to VRChat instantly through gateway events; the timed pass is the safety net and handles the VRChat to Discord direction.
- Per member and per linked pair the bot stores the last state of both sides. Whichever side changed gets mirrored; if both sides changed against each other in the same window, Discord wins.
- Tracker channels rename at most once every 6 minutes per channel because Discord itself limits channel renames to about 2 per 10 minutes.

## Data and logs

- Everything lives in `data/`: `group-link.sqlite` (links, pairs, trackers), `vrchat_cookies.json` (session), and `logs/` (daily files, two weeks kept).
- Secrets stay in `.env`; non-secret settings (log channels, presence) live in `config.yml`.
- Logs never contain passwords, tokens, or cookies.
- Delete `data/vrchat_cookies.json` to force a fresh VRChat login.
- `test/simulate-link.js` runs the whole /link flow against the real VRChat API with mock Discord objects (needs VRChat credentials in the environment).

## Credits

Built by VRChat Legends. The VRChat auth and rate limiting layers are battle tested code carried over from the VRChat Legends website backend.

Not affiliated with VRChat Inc. Be a good API citizen: keep the default pacing unless you know exactly what you are doing.
