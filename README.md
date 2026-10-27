# Limbo-Backend

The backend for [Limbo](https://github.com/ArielS-gif/Limbo): a fork of
[vopswtf/Fortify-Alpha](https://github.com/vopswtf/Fortify-Alpha) with:

- `src/routes/ot65.js`: Limbo's routes: the player's loadout and backpack for a zone, saving them when they leave,
  mission rewards, hosted games and co-op launch screens (LAN and VPN addresses only, not the open internet).
- `src/xmpp.js`: a small XMPP chat and presence server on port 5222 (GLOBAL chat, friends, party messages).
- The Play tab's missions that name generators OT6.5 doesn't have are served with the nearest one it has
  (`src/routes/misc.js`), and every mission has its own GUID (`common/world_info.json`).
- Fixes: unknown MCP operations answer a no-op instead of failing, quest objective counts, worker slots, deleting the
  equipped hero, purchase quantities and prices, login rewards, Home Base settings, gameplay stats, mode loadouts,
  cloud storage, and party session lookups.

Setup: Node.js and MongoDB, `npm install`, copy `.env.example` to `.env` (`PORT=3551`, your `MONGO_URI`, a long random
`JWT_SECRET`), then start it with Limbo's `Play Limbo.bat` (or `node index.js`). Fortify-Alpha has no license; its
original code stays its author's. The original README follows.

---

# Fortify-Alpha
backend for OT6.5 that uses game data to be more accurate

credit @notpies for og research about OT6
https://github.com/NOTPIES

important
- to make an account just login with the username you want before the @
- passwords are hashed and are enforced based on said username
- use the email suffix "@reset.me" to reset your profile when logging in
- outpost mission is skipped because you cant load into outpost, causes some funky stuff with tutorial (restart game if anything happens)
- uses mongodb

done
- quest progression (finished notifications)
- building survivor slots
- profile system
- creating buildings
- upgrading schems/workers/buildings (havent put in resource checks for workers and buildings yet)
- tutorial functional (outpost mission is skipped)
- cloudstorage (uses ztsd to compress and stick in in mongo, not production worthy use an s3 bucket for that)
- hero creation and perk stuff, currently when you create a hero it will start at max level
- basic llama system (needs to be expanded)

not done
- missing some mcp operations probably
- world info is a newer version then intended, i cant be bothered to make one (if someone wants to go for it, you can find all the missiongens and zonethemes in the ot files)
- outposts work differently in ot not sure but idk i'll probably look into it eventually
