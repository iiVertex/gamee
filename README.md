# yoink!

A colorful **first-person 3D multiplayer party game** for the browser, built with **Three.js**, **Node.js**, **Express** and **Socket.IO**, with accounts and progress stored in **SQLite**.

Five game modes, seven maps with real explorable buildings, map voting, bots for practice, friends, parties with real-time invitations, three chat channels, coins, crates and weapon skins.

---

## Quick start (local)

Requirements: **Node.js 18.17 or newer** (tested on Node 22) and a modern desktop browser with WebGL (Chrome, Edge or Firefox).

**Windows:** double-click **`start-yoink.bat`**. It installs the dependencies the first time, starts the server and opens the game in your browser. Keep that window open while you play.

**Any OS, from a terminal:**

```bash
npm install
npm start
```

Then open **http://localhost:3000**, create an account and play. The server prints your LAN address too, for example `http://192.168.1.20:3000`. (`./start-yoink.sh` does the same on macOS/Linux and opens the browser for you.)

> **Don't open `client/index.html` directly** (a `file://` page). The game, accounts and multiplayer are served by the yoink! server, so the page only works at `http://localhost:3000` while the server is running. Opened as a file it just shows these instructions.

* An account is required for everything, including practice against bots.
* Data is saved in `data/yoink.db` (SQLite, written atomically). Delete that file to reset all accounts.
* No native build tools are needed: the database runs on `sql.js` (SQLite compiled to WebAssembly), and password hashing uses Node's built-in `scrypt`.

### Testing with several browser windows

Each browser **tab or window keeps its own login** (the session token lives in `sessionStorage`), so you can open several windows on `http://localhost:3000` and log into a different account in each. That's the easiest way to test friends, parties, invitations, chat and online matches on one PC.

* Leave **"Stay logged in on this device"** unchecked when testing several accounts. When checked, the token is also stored in `localStorage` and new tabs reuse that account.
* Private/incognito windows also work.
* One account can only be connected once. Logging into the same account in another window disconnects the older window.

### Playing with friends on the same network (LAN)

Start the server on one PC and have friends open the printed **LAN** address (`http://<your-LAN-IP>:3000`). On Windows, allow Node.js through the firewall when prompted (Private networks).

### Playing with friends over the internet

**Public hosting is not configured in this project.** The server runs on your machine, and friends outside your network need a way to reach it. Pick one:

1. **Port forwarding.** Forward TCP port 3000 on your router to the PC running the server, allow it in the Windows firewall, and share `http://<your-public-IP>:3000`. Your public IP can change, and some ISPs (CGNAT) block this entirely.
2. **A tunnel (easiest).** Keep `npm start` running and in another terminal run one of:
   * Cloudflare Tunnel: `cloudflared tunnel --url http://localhost:3000`
   * ngrok: `ngrok http 3000`

   Share the HTTPS URL it prints. Both support the WebSockets the game uses.
3. **A server / VPS / cloud host** (any Node.js host, e.g. a small VPS, Render, Railway or Fly.io): copy the project, run `npm install --omit=dev` and `npm start`, set `PORT` if the host requires it, and put it behind HTTPS. Behind a reverse proxy, also set `TRUST_PROXY=1` so rate limiting sees real client IPs. Use a persistent disk for `data/` (or set `YOINK_DB`) so accounts survive restarts.

Everyone connects to the same server address. Each friend makes their own account, adds the others as friends (Friends tab → search by username), and the party leader invites them (Party tab).

### Static hosting (Vercel, Netlify…): single-player vs bots

Hosts that only serve static files can't run the multiplayer server, so there is also a serverless build where the server modules run inside the page:

```bash
npm run build:static   # writes dist/
```

Upload `dist/` to any static host. On **Vercel**, just import the repo: `vercel.json` already sets the install command, build command and output directory. In this version:

* There are no real players. **Play** starts a match with bots right away (full coins), and **Practice** works as usual (half coins).
* There's no login. Each browser gets a guest account, and coins, skins and stats are saved in that browser's `localStorage`.
* Friends and parties are hidden.

### Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP/WebSocket port |
| `HOST` | `0.0.0.0` | Interface to listen on (`127.0.0.1` = this PC only) |
| `YOINK_DB` | `data/yoink.db` | SQLite database file |
| `TRUST_PROXY` | unset | Number of reverse proxies/tunnels in front of the server that set `X-Forwarded-For` (usually `1`), or an address/subnet list. Leave unset when players connect directly |
| `YOINK_OPEN` | unset | Set to `1` to open the game in your browser once the server starts (the launchers do this) |

---

## How to play

### Controls (rebindable in Settings)

| Action | Default |
|---|---|
| Move | **W A S D** |
| Look | Mouse (click the game to capture the pointer) |
| Jump / Sprint | **Space** / **Left Shift** |
| Punch, tag, shoot | **Left mouse** |
| Aim down sights | **Right mouse** |
| Interact: doors, pick up, search containers, harvest, pass the Boob-tato, grab the chicken, use crafting bench | **E** |
| Reload | **R** |
| Use bandage / medkit | **H** |
| Hands / weapon slots | **1 2 3 4** or mouse wheel |
| Drop held weapon | **G** |
| Inventory & crafting | **I** |
| Scoreboard (hold) | **Tab** |
| Chat | **Enter** or **T** (button switches ALL / PARTY) |
| Release mouse / pause menu | **Esc** |

The camera is always first-person at eye height. Your arms, fists, held weapons and objective items show in first person. Other players see your full character with animations, your held weapon (with your skin) and your name tag. Bots have a 🤖 tag, a BOT label and an antenna.

### Game modes

| Mode | Rules | Winning |
|---|---|---|
| 🏃 **TAG** | A random player starts as **IT** (red ring + "IT!" marker). IT punches someone to pass it on. Newly tagged players wait 2 s before tagging, and there are no immediate tag-backs. IT runs 10% faster. | When the 2:30 timer ends, whoever is IT loses and everyone else wins. |
| 🔥 **HOT POTATO** | One player holds the **Boob-tato**, a squishy, googly-eyed cartoon meme prop. Get close and press **E** (or click) to pass it. The fuse bar shows when it pops, and it glows and ticks faster near the end. | When it pops, the holder loses a life (2 lives). Out of lives = eliminated. Rounds repeat until one player is left. |
| 🐔 **GRAB THE ITEM** | Find the **Golden Rubber Chicken** (follow the marker), grab it, and carry it to the glowing **winning table**. Punch the carrier to knock it loose; anyone can pick it up. Carriers move slower and get 1.5 s of grab protection. | Stand at the table for 2 s to deliver it. First delivery wins. If time runs out, the player who held it longest wins. |
| 🔫 **HIDDEN GUNS** | Everyone starts unarmed. Search houses, garages, warehouses, labs, containers and safes (**E**, takes a second) for pistols, revolvers, SMGs, shotguns, assault rifles, sniper rifles, the rare Yoink Blaster, ammo, bandages, medkits and armor. | Last survivor wins. Eliminated players spectate. |
| 🛠️ **SCAVENGE & CRAFT** | Start with nothing. Harvest wood piles, scrap heaps and machine parts outdoors, and search containers for wood, scrap metal, cloth, mechanical parts, gunpowder, electronics and Rare Alloy. Craft at **crafting benches** inside buildings: guns, ammo, bandages, medkits and armor. Better guns need rarer materials. | Last survivor wins. |

Every match starts with a **map vote** (previews, names, live vote counts, timer). You can change your vote until the timer ends. The map with the most votes is loaded, ties are broken randomly, and only players vote (bots don't).

### Maps

| Map | Highlights |
|---|---|
| **Forest Town** | Two-storey houses, garages, a lumber mill with mezzanine, cabins in thick pine woods |
| **Dust Valley** | Adobe homes with roof access, saloon, sheriff office, general store, warehouses, boxcars, lookout towers |
| **Frostbite** | Snowy cabins, a frozen lake, a research facility with labs and safes, storage hall, snowfall |
| **Rust Harbor** | Stacked container yard with stair towers, cranes, a moored cargo ship with a bridge, warehouses, harbour office. Don't fall in the water |
| **Abandoned Mall** | Two floors of shops around a skylit atrium, escalators, department store, food court, back corridors and storage rooms |
| **Industrial Yard** | Warehouses, factory hall, silos, trailers, ramps up to a raised central platform with the winning table |
| **Rooftop Chaos** | Nine rooftops at different heights joined by bridges and ramps, huts, greenhouses, a helipad. Falling = respawn (or damage in combat modes) |

### Practice and bots

**Practice vs bots** starts a match immediately, with bots filling it up to 4 players. **Find match** is for real players: it groups players (and whole parties) per mode, and a match with 2, 3, 4 or more real players has **no bots**. Whoever queued first is the lobby host (for a party, its leader) and can press **Start now (N players)** as soon as a second player is there; otherwise the match starts on its own 12 s after the second player joins, or immediately at 8. If you're alone in the queue, you can start right away with bots, or bots fill in after 25 s. Every mode works with as few as 2 players. Bots chase and flee in Tag, pass the Boob-tato, steal and deliver the chicken, loot and fight in Hidden Guns, and gather, craft and fight in Scavenge & Craft. Practice matches pay 50% coins.

### Friends, parties and chat

* **Friends tab**: search usernames, send/accept/decline requests, see live online status, view profiles, remove or block.
* **Party tab**: you need at least one friend to create a party (inviting a friend also creates one). Up to 4 members. Invite **online friends**: they get a real-time popup with **ACCEPT / DECLINE** that expires after 60 s. The leader picks the mode and starts once everyone is **READY**, and the party always lands in the same match. If the leader disconnects, leadership moves to another online member. Disconnected members keep their slot for 20 s.
* **Chat**: **Lobby** (everyone not in a match), **Party** (members only), **Match** (players in your match) and **Party in-game** (party members in the same match). The server enforces every channel, rate-limits spam, strips control characters and caps length. All text renders as plain text. Click a name to view their profile, mute, block or report. The server posts announcements for round starts, eliminations, deliveries, pops, victories and rare unboxings.

### Coins, crates and skins

Coins are awarded by the server at the end of each match: participation, victory, and mode objectives (tags, untouchable, rounds survived, passes, deliveries, steals, chicken time, eliminations, survival time, crafting, runner-up). New accounts start with 300 coins.

| Crate | Price | Common | Rare | Epic | Legendary |
|---|---|---|---|---|---|
| Basic | 150 | 70% | 22% | 6.5% | 1.5% |
| Premium | 400 | 35% | 38% | 20% | 7% |
| Legend | 900 | 0% | 40% | 40% | 20% |

The server rolls the rarity with a cryptographic RNG, then picks a skin of that rarity uniformly. Each crate purchase carries a request id, so a retried or double-clicked purchase is charged at most once. Duplicates refund coins (30 / 75 / 160 / 350). There are 42 skins (6 per weapon), all purely cosmetic: equip them in the **Armory** and they appear on your first-person gun and the gun other players see.

### Settings

Master / effects / music volume, mouse sensitivity, invert Y, field of view, graphics quality, FPS/ping counter and key rebinding.

**Graphics quality:**
* **Low**: no shadows, 0.75× resolution, shorter view distance. Recommended for laptops and PCs without a dedicated graphics card.
* **Auto** (default): Low or Medium, based on the CPU.
* **Medium / High**: real-time shadows and higher resolution.

In Chrome/Edge make sure *Use graphics acceleration when available* is enabled.

---

## Development

```bash
npm run dev        # restart the server on file changes
npm test           # unit + integration tests (see below)
npm run previews   # re-render the map vote thumbnails (needs Chromium/Chrome)
```

### Tests

`npm test` runs, with Node's built-in test runner:

* **tests/social.test.js**: registration validation, unique names, scrypt hashes, logout invalidating sessions, friend requests, party invitations (accept / decline / expiry), party-chat isolation, lobby chat, spam limits, blocking, leadership transfer, and idempotent crate purchases.
* **tests/match.test.js**: full practice matches over real sockets: map vote, load, countdown, movement, anti-cheat correction of a teleport, server-validated actions, in-game chat permissions, results with coins saved to the database, rejoining after a disconnect, and a party queuing into the same match.
* **tests/sim.test.js**: bot-only matches of **all 5 modes on all 7 maps** (35 matches, fast-forwarded), each checked for a valid finish.
* **tests/maps.test.js**: every map builds, and every spawn, loot spot, container, bench, resource and objective is reachable on the bot navigation graph.
* **tests/physics.test.js**: gravity, collisions, step-up, jumping, no tunnelling.
* **tests/robustness.test.js**: a hostile client: malformed payloads on every kind of socket event (the server must keep running), speed hacks and flying (must be corrected).

Browser checks in `tools/` drive the real client with Playwright (`playwright-core`). Set `CHROMIUM_PATH` to a Chrome/Chromium executable if needed:

* `node tools/e2e.mjs grab` plays a whole (shortened) practice match in the browser through to the results screen.
* `node tools/multi-e2e.mjs` runs two windows in the same online match: movement sync and a server-validated shot.
* `node tools/ui-tour.mjs` covers two users: friend request, live invite popup, party, chat, crate opening, armory, profile.
* `node tools/craft-e2e.mjs` crafts at a bench in the browser.
* `node tools/validate-maps.mjs` and `node tools/perf-probe.mjs low` validate maps and measure draw calls.

### Project layout

```
server/            Express + Socket.IO server
  index.js         HTTP server, static files, socket auth
  auth.js          register/login/logout, scrypt, sessions (hashed tokens)
  db.js            sql.js SQLite with atomic file persistence
  friends.js party.js chat.js economy.js profiles.js matchmaking.js
  match/           Match lifecycle, modes/, bots.js, nav.js (A* grid), inventory.js
shared/            code shared by server and browser
  physics.js       collision world + character controller
  mapbuilder.js buildings.js maps/   deterministic map generation (7 maps)
  items.js skins.js constants.js
client/            the browser game (ES modules, no build step)
  js/game/         Game.js (FP controller, netcode, interactions), world.js, models.js,
                   avatar.js, viewmodel.js, hud.js, effects.js, input.js, textures.js
  js/ui/           auth, menu tabs, vote, loading, results, settings, chat panel
  assets/previews/ map thumbnails for the vote screen
tests/  tools/
start-yoink.bat    Windows launcher (install once, start server, open browser)
start-yoink.sh     same for macOS/Linux
```

### How multiplayer works

* The client predicts its own movement with the same physics code as the server and sends its position at 20 Hz. The server validates every update: a per-player distance budget (sending packets faster doesn't make you faster), a jump-arc check (no flying or hovering), no passing through walls, fences or floors, no standing inside solids, teleports and frozen states. Invalid moves are snapped back.
* Interactions need reach: loot, containers, resources, doors, the chicken and potato passes are refused through walls.
* Lag compensation uses a round-trip time measured by the server, for shots and for punches/tags, against humans and bots alike.
* The server is authoritative for everything else: tags, passes, punches, item possession and deliveries, loot pickup ranges, container searches, ammo, reloads, fire rate, hit detection (server-side raycasts with lag compensation), damage, armor, healing, crafting (bench distance + materials), eliminations, timers, win conditions, rewards, coins, crates and skins.
* Snapshots go out at 20 Hz and other players are interpolated about 110 ms behind for smooth motion.
* If you lose connection mid-match you have 45 s to come back: reconnecting (or reloading the page) puts you straight back into the same match, including during the map vote. If the match ended meanwhile, you are sent back to the menu.

### Security notes

* Passwords are hashed with **scrypt** and a per-user salt. The database only stores a SHA-256 hash of each session token.
* Every socket connection is authenticated with the session token. Logging out deletes the session server-side.
* Login and registration are rate limited (per address and per account name). Socket payloads are type-checked, a broken packet can't crash the server, and chat text is sanitized and rendered as text (never HTML).
* Party chat is only visible to members, and only from the moment they joined.
* Clients can't grant themselves coins, wins, skins or items: all of those are computed and persisted by the server.

### Known limitations

* Movement is client-predicted with server-side validation (typical for browser games), not fully server-simulated, so the anti-cheat is basic rather than competitive-grade.
* There is no built-in HTTPS. Use a tunnel or reverse proxy for internet play.
* Bots use a navigation grid with A*. They are fun but not perfect, and can occasionally take odd routes in tight spaces.
