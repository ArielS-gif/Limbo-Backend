# Limbo-Backend

This is the backend for [Limbo](https://github.com/ArielS-gif/Limbo). It's based on
[Fortify-Alpha](https://github.com/vopswtf/Fortify-Alpha) by vopswtf, with a few things added:

- Co-op: hosting, joining, and starting missions together
- Saving your backpack and rewards between missions
- Chat with friends (runs on port 5222)
- Missions from the Play tab that didn't work before now open
- Every homebase is fully built (top power level), and no map tile waits on a quest
- No MongoDB: accounts are saved as files in the `data` folder, so there's nothing else to install
- A bunch of small bug fixes

## Setup

1. Download `Limbo-Backend.zip` from [Releases](https://github.com/ArielS-gif/Limbo-Backend/releases) and unzip it
   next to Limbo. (Use this instead of "Download ZIP", which names the folder `Limbo-Backend-main`.)
2. Start it with Limbo's `Play Limbo.bat`. The first time, it installs Node.js if it's missing, runs `npm install` and
   makes a `.env`.

To run it without Limbo: install [Node.js](https://nodejs.org), run `npm install`, copy `.env.example` to `.env` and
fill it in (`PORT=3551` and any long random `JWT_SECRET`), then run `node index.js`.

Accounts are saved in the `data` folder. Delete it to start over.

The original Fortify-Alpha code belongs to vopswtf. Their README is below.

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
