// OTGameServer, the DLL that runs missions inside the OT6.5 client itself, reports here. There is no token on these
// routes, so they answer only this machine and private networks: a LAN, or the VPN friends play over (Radmin VPN's
// 26.x, Tailscale's 100.64-127.x), where a friend's copy can host the zone (it reads and saves its players' loadouts
// here). Not the open internet, even with the port forwarded.
const crypto = require("crypto");
const ProfileModel = require("../model/profile");
const ProfileWrapper = require("../util/ProfileWrapper");
const { getItem } = require("../util/gameData");
const quests = require("../util/quests");
const tutorial = require("../util/tutorial");
const worldInfo = require("../../common/world_info.json");

// The highest harvest-weapon tier a hero's kits know (Kit_HarvestWeapon_T01..T08 = tags Homebase.HarvestWeapon.Tier0..7).
const kMaxHarvestTier = 7;
// The crafting materials a zone starts with come from the profile, up to this many of each.
const kMaxZoneStack = 999;
// Profile item -> the client's world item asset folder.
const kZoneItemFolders = {
    Ingredient: "/Game/Loot/Ingredients",
    Resource: "/Game/Loot/ResourcePickups",
};
const kZoneResources = new Set(["wooditemdata", "stoneitemdata", "metalitemdata"]);

function clientIp(req) {
    return (req.socket.remoteAddress || "").replace(/^::ffff:/, "");
}

function isLoopback(req) {
    const ip = clientIp(req);
    return ip === "127.0.0.1" || ip === "::1";
}

function isLocal(req) {
    const ip = clientIp(req);
    if (isLoopback(req)) return true;
    const p = ip.split(".").map(Number);
    if (p.length !== 4 || p.some((n) => !(n >= 0 && n <= 255))) return false;
    return p[0] === 10 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) ||
        p[0] === 26 || (p[0] === 100 && p[1] >= 64 && p[1] <= 127);
}

// world_info lists the rewards of a later build ("CardPack:zcp_schematicxp_t07"); this client has the 2016 zone card
// packs instead (Items/CardPacks/ZoneRewards/ZoneCardPack_Resources_SchematicXP_T07). Profile items use "Type.name".
const kZoneCardPacks = {
    zcp_schematicxp: "zonecardpack_resources_schematicxp",
    zcp_heroxp: "zonecardpack_resources_personnelxp",
    zcp_personnelxp: "zonecardpack_resources_personnelxp",
};

function profileItemOf(itemType) {
    const [type, name] = itemType.split(":");
    if (!type || !name) return null;
    if (type === "CardPack") {
        const tier = name.match(/_(t\d+)$/);
        const pack = tier && kZoneCardPacks[name.slice(0, -tier[0].length)];
        return pack ? `CardPack.${pack}_${tier[1]}` : null;
    }
    if (type === "AccountResource") return `AccountResource.${name}`;
    return null;
}

function missionRewards(theaterId, missionGuid) {
    const theater = (worldInfo.missions || []).find((m) => m.theaterId === theaterId);
    const mission = theater && (theater.availableMissions || []).find((m) => m.missionGuid === missionGuid);
    if (!mission) return null;
    const items = [...(mission.missionRewards?.items || [])];
    const alerts = (worldInfo.missionAlerts || []).find((a) => a.theaterId === theaterId);
    const alert = alerts && (alerts.availableMissionAlerts || []).find((a) => a.tileIndex === mission.tileIndex);
    if (alert) items.push(...(alert.missionAlertRewards?.items || []));
    return items;
}

// A world item's profile template id from its asset path: "/Game/Weapons/WeaponItemData/Assault/Assault_Auto_T02.
// Assault_Auto_T02" -> "Weapon.assault_auto_t02".
const kBackpackTypes = [
    ["/Game/Weapons/WeaponItemData/", "Weapon"],
    ["/Game/Weapons/AmmoItemData/", "Ammo"],
    ["/Game/Items/Traps/", "Trap"],
    ["/Game/Items/Consumables/", "Consumable"],
];

function templateIdOfPath(path) {
    const name = path.split(".").pop().toLowerCase();
    const type = kBackpackTypes.find(([prefix]) => path.startsWith(prefix));
    return `${type ? type[1] : "WorldItem"}.${name}`;
}

// "/Game/Loot/Ingredients/Ingredient_Nuts_Bolts.Ingredient_Nuts_Bolts" -> "Ingredient.ingredient_nuts_bolts".
function materialTemplateIdOfPath(path) {
    const name = path.split(".").pop().toLowerCase();
    const type = Object.entries(kZoneItemFolders).find(([, folder]) => path.startsWith(folder + "/"));
    return type ? `${type[0]}.${name}` : null;
}

// "Hero.class_commando" -> "Class_Commando", the asset under /Game/Heroes.
function heroAssetOf(templateId) {
    const data = getItem(templateId);
    if (data?.Name) return data.Name;
    return templateId.split(".")[1].split("_").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("_");
}

// Co-op: the games hosted by this backend's players (a host's DLL refreshes its entry while it listens) and where a
// player connects to join one. A host on the backend's own PC is reached at the address the joining player reached the
// backend through (127.0.0.1 on the same PC, the backend PC's LAN or VPN address from another one); a host on another
// PC at the address its announcement came from.
const kSessionTtlMs = 45000, kMaxPlayers = 4;
const sessions = new Map();  // accountId -> { accountId, port, zone, players, at }

// Co-op launch screens: the first player to press Play on the Play tab opens a lobby here (their mission, their clock);
// others who press Play while it is open join it and see the same clock; when it runs out or anyone launches, the host
// opens the zone and the others join it once it is announced (sessions above). Times go out as milliseconds left, so
// two PCs' clocks don't matter. Players on another PC use these too, so they aren't local-only; they only touch this
// table.
const kLobbyLaunchedTtlMs = 180000;  // a launched lobby waits this long for its host's zone to be announced
const lobbies = new Map();  // host accountId -> { host, missionId, theaterId, members: Set, endsAt, launchedAt }
const kAccountId = /^[0-9a-f]{32}$/;

function lobbyState(lobby, req) {
    const now = Date.now();
    const session = sessions.get(lobby.host);
    const host = (req.headers.host || "127.0.0.1").replace(/:\d+$/, "");
    return {
        host: lobby.host,
        missionId: lobby.missionId,
        remainingMs: lobby.launchedAt ? 0 : Math.max(0, lobby.endsAt - now),
        launched: !!lobby.launchedAt,
        players: 1 + lobby.members.size,
        address: session && now - session.at < kSessionTtlMs ? `${session.remote || host}:${session.port}` : "",
    };
}

function liveLobby(lobby) {
    const now = Date.now();
    if (lobby.launchedAt) return now - lobby.launchedAt < kLobbyLaunchedTtlMs;
    return now < lobby.endsAt + 5000;  // the host launches when the clock runs out
}

module.exports = (app) => {

    // Play Limbo.bat, before the game starts: whether this player's accounts skip the homebase tutorial.
    app.post("/fortnite/api/game/v2/ot65/tutorial/:choice", (req, res) => {
        if (!isLocal(req)) return res.status(403).json({ error: "local_only" });
        if (req.params.choice !== "skip" && req.params.choice !== "play") return res.status(400).json({ error: "invalid_request" });
        tutorial.setChoice(req, req.params.choice === "skip");
        res.json({ tutorial: req.params.choice });
    });

    app.post("/fortnite/api/game/v2/ot65/session", (req, res) => {
        if (!isLocal(req)) return res.status(403).json({ error: "local_only" });
        const { accountId, port, zone, players, closed } = req.body || {};
        if (!accountId) return res.status(400).json({ error: "invalid_request" });
        if (closed) {
            sessions.delete(accountId);
            lobbies.delete(accountId);  // its launch screen's players have joined by now, or never will
        }
        else sessions.set(accountId, { accountId, port: port || 7777, zone: zone || "", players: players || 1, at: Date.now(),
                                       // a host on another PC is reached at its own address; one on this PC, as the backend is
                                       remote: isLoopback(req) ? "" : clientIp(req) });
        res.json({ sessions: sessions.size });
    });

    // Play pressed: { accountId, missionId, theaterId, seconds }. Joins another player's open lobby (or tells the
    // address of a game already running), else opens this player's own. With { host }: Join on that friend in the
    // Friends list, their launch screen or game only ({ none } when they have neither).
    app.post("/fortnite/api/game/v2/ot65/lobby/play", (req, res) => {
        const { accountId, missionId, theaterId, seconds, host: friend } = req.body || {};
        if (!kAccountId.test(accountId || "")) return res.status(400).json({ error: "invalid_request" });
        for (const [key, lobby] of lobbies) if (!liveLobby(lobby)) lobbies.delete(key);
        for (const lobby of lobbies.values()) lobby.members.delete(accountId);
        lobbies.delete(accountId);
        const now = Date.now();
        const wanted = (host) => !friend || host === friend;
        const running = [...sessions.values()].find((s) => now - s.at < kSessionTtlMs && s.accountId !== accountId &&
                                                           s.players < kMaxPlayers && wanted(s.accountId));
        const open = [...lobbies.values()].find((l) => l.host !== accountId && 1 + l.members.size < kMaxPlayers && wanted(l.host));
        if (friend && !open && !running) return res.json({ none: true });
        if (open) {
            open.members.add(accountId);
            console.log(`[OT6.5] ${accountId} joined ${open.host}'s launch screen (${1 + open.members.size} players)`);
            return res.json({ joined: lobbyState(open, req) });
        }
        if (running) {
            const host = (req.headers.host || "127.0.0.1").replace(/:\d+$/, "");
            return res.json({ running: { host: running.accountId, address: `${running.remote || host}:${running.port}` } });
        }
        const lobby = { host: accountId, missionId: missionId || "", theaterId: theaterId || "", members: new Set(),
                        endsAt: now + (Math.min(Math.max(seconds || 60, 5), 300) * 1000), launchedAt: 0 };
        lobbies.set(accountId, lobby);
        console.log(`[OT6.5] ${accountId} opened a launch screen for mission ${lobby.missionId}`);
        res.json({ opened: lobbyState(lobby, req) });
    });

    // A launch screen's state, asked every second by its players.
    app.get("/fortnite/api/game/v2/ot65/lobby/:host", (req, res) => {
        const lobby = lobbies.get(req.params.host);
        if (!lobby || !liveLobby(lobby)) return res.json({ closed: true });
        res.json(lobbyState(lobby, req));
    });

    // Launch pressed by anyone on it (the host opens the zone), or the host's clock ran out.
    app.post("/fortnite/api/game/v2/ot65/lobby/:host/launch", (req, res) => {
        const lobby = lobbies.get(req.params.host);
        if (!lobby || !liveLobby(lobby)) return res.json({ closed: true });
        if (!lobby.launchedAt) {
            lobby.launchedAt = Date.now();
            console.log(`[OT6.5] ${req.params.host}'s launch screen launched (${1 + lobby.members.size} players)`);
        }
        res.json(lobbyState(lobby, req));
    });

    // Left the launch screen: { accountId }. The host leaving closes it.
    app.post("/fortnite/api/game/v2/ot65/lobby/:host/leave", (req, res) => {
        const { accountId } = req.body || {};
        const lobby = lobbies.get(req.params.host);
        if (lobby && accountId === lobby.host && !lobby.launchedAt) lobbies.delete(req.params.host);
        else if (lobby) lobby.members.delete(accountId);
        res.json({ ok: true });
    });

    // The players a Friends list can join right now (an open launch screen or a game with room), one account id a line.
    app.get("/fortnite/api/game/v2/ot65/joinable/:accountId", (req, res) => {
        const now = Date.now();
        const hosts = new Set();
        for (const lobby of lobbies.values())
            if (liveLobby(lobby) && 1 + lobby.members.size < kMaxPlayers) hosts.add(lobby.host);
        for (const s of sessions.values()) if (now - s.at < kSessionTtlMs && s.players < kMaxPlayers) hosts.add(s.accountId);
        hosts.delete(req.params.accountId);
        res.type("text/plain").send([...hosts].join("\n") + "\n");
    });

    app.get("/fortnite/api/game/v2/ot65/sessions", (req, res) => {
        const host = (req.headers.host || "127.0.0.1").replace(/:\d+$/, "");
        const now = Date.now();
        const open = [...sessions.values()]
            .filter((s) => now - s.at < kSessionTtlMs && s.accountId !== req.query.accountId && s.players < kMaxPlayers)
            .map((s) => ({ accountId: s.accountId, address: `${s.remote || host}:${s.port}`, zone: s.zone, players: s.players }));
        res.json(open);
    });

    // The player's hero for the zone, as plain lines the DLL reads: the hero asset, gender, the ability points in the
    // primary and the four secondary traits, the harvest tier (the pickaxe) and the gadgets chosen in the lobby.
    app.get("/fortnite/api/game/v2/ot65/loadout/:accountId", async (req, res) => {
        if (!isLocal(req)) return res.status(403).json({ error: "local_only" });
        const profile = await ProfileModel.findOne({ accountId: req.params.accountId, profileId: "profile0" });
        if (!profile) return res.status(404).json({ error: "profile_not_found" });
        const stats = profile.stats.attributes;
        const hero = profile.items[stats.defaultHeroId];
        const lines = [];
        if (hero && hero.templateId.startsWith("Hero.")) {
            const a = hero.attributes || {};
            lines.push(`hero ${heroAssetOf(hero.templateId)}`);
            lines.push(`gender ${a.gender || 1}`);
            lines.push(`level ${a.level || 1}`);
            lines.push(`points ${[a.Primary_Trait_Abilities, a.Secondary_Trait_Alpha_Abilities, a.Secondary_Trait_Beta_Abilities,
                a.Secondary_Trait_Gamma_Abilities, a.Secondary_Trait_Delta_Abilities].map((n) => n || 0).join(" ")}`);
        }
        lines.push(`harvest ${kMaxHarvestTier}`);
        // Crafting ingredients and building materials: "item <asset path> <count>".
        for (const item of Object.values(profile.items)) {
            const [type, name] = String(item.templateId).split(".");
            const folder = kZoneItemFolders[type];
            if (!folder || !name || (type === "Resource" && !kZoneResources.has(name))) continue;
            if (type === "Ingredient" && !name.startsWith("ingredient_")) continue;
            const asset = getItem(item.templateId)?.Name;
            const count = Math.min(item.quantity || 0, kMaxZoneStack);
            if (asset && count > 0) lines.push(`item ${folder}/${asset}.${asset} ${count}`);
        }
        // The profile's schematics, "schematic <item id> <name>": a joined player's craft names its schematic by the id,
        // and the hosting copy has only its own player's profile.
        for (const [id, item] of Object.entries(profile.items))
            if (String(item.templateId).startsWith("Schematic.")) lines.push(`schematic ${id} ${item.templateId.slice("Schematic.".length)}`);
        for (const loadout of [...(stats.mode_loadouts || []), ...((hero && hero.attributes.mode_loadouts) || [])]) {
            for (const gadget of loadout.selectedGadgets || []) {
                const name = typeof gadget === "string" ? gadget : gadget?.gadget || gadget?.itemId || "";
                if (name) lines.push(`gadget ${name.split(/[.:]/).pop()}`);
            }
        }
        // The outposts' structures, "structure <outpost> <asset> <level>": what was upgraded there (limbo_outposts), and
        // the storm shield at least one level for each of the outpost's quests won.
        const outposts = stats.limbo_outposts || {};
        for (let n = 1; n <= 4; n++) {
            const levels = { ...(outposts[n] || {}) };
            const quest = new RegExp(`^Quest\\.outpostquest_t${n}_l\\d+$`, "i");
            const won = Object.values(profile.items).filter((item) => quest.test(item.templateId) &&
                (item.attributes.quest_state === "Completed" || item.attributes.quest_state === "Claimed")).length;
            levels.Outpost_StormShield = Math.max(levels.Outpost_StormShield || 0, won);
            for (const [asset, level] of Object.entries(levels)) if (level > 0) lines.push(`structure ${n} ${asset} ${level}`);
        }
        // The backpack: what the player carried out of the last zone (theater0), "backpack <asset path> <count> <slot>".
        const backpack = await ProfileModel.findOne({ accountId: req.params.accountId, profileId: "theater0" });
        for (const item of Object.values(backpack?.items || {})) {
            const a = item.attributes || {};
            if (a.asset_path && item.quantity > 0) lines.push(`backpack ${a.asset_path} ${item.quantity} ${a.quickbar_slot ?? -1}`);
        }
        res.type("text/plain").send(lines.join("\n") + "\n");
    });

    // Leaving a zone: the backpack replaces theater0's items, and the materials used or gathered there change the
    // campaign profile. Body: { accountId, backpack: [{ path, count, slot }], materials: [{ path, delta }] }.
    app.post("/fortnite/api/game/v2/ot65/zone/leave", async (req, res) => {
        if (!isLocal(req)) return res.status(403).json({ error: "local_only" });
        const { accountId, backpack = [], materials = [] } = req.body || {};
        if (!accountId) return res.status(400).json({ error: "missing_fields" });

        const theater = await ProfileModel.findOne({ accountId, profileId: "theater0" });
        if (theater) {
            theater.items = {};
            for (const entry of backpack) {
                if (!entry.path || !(entry.count > 0)) continue;
                theater.items[crypto.randomUUID()] = {
                    templateId: templateIdOfPath(entry.path),
                    attributes: { asset_path: entry.path, quickbar_slot: entry.slot ?? -1, level: 1, item_seen: true },
                    quantity: entry.count,
                };
            }
            theater.markModified("items");
            await theater.save();
        }

        const profile = await ProfileModel.findOne({ accountId, profileId: "profile0" });
        const changed = [];
        if (profile) {
            const wrapper = new ProfileWrapper(profile);
            for (const { path, delta } of materials) {
                const templateId = path && materialTemplateIdOfPath(path);
                if (!templateId || !delta) continue;
                const found = wrapper.findTemplateId(templateId);
                if (found) {
                    found.value.quantity = Math.max(0, (found.value.quantity || 0) + delta);
                    profile.markModified(`items.${found.key}`);
                } else if (delta > 0) {
                    wrapper.addQuantity(templateId, delta);
                }
                changed.push(`${templateId} ${delta > 0 ? "+" : ""}${delta}`);
            }
            if (changed.length) await profile.save();
        }
        console.log(`[OT6.5] ${accountId} left a zone: backpack ${backpack.length} item(s), materials ${changed.join(", ") || "unchanged"}`);
        res.json({ backpack: backpack.length, materials: changed });
    });

    // An outpost structure upgraded in the zone (the outpost menu's Build): its new level is kept for the outpost, and
    // the account items it cost come off the campaign profile (the zone took its own items out already).
    // Body: { accountId, outpost, structure, level, accountItems: [{ name, quantity }] }.
    app.post("/fortnite/api/game/v2/ot65/outpost/upgrade", async (req, res) => {
        if (!isLocal(req)) return res.status(403).json({ error: "local_only" });
        const { accountId, outpost, structure, level, accountItems } = req.body || {};
        if (!accountId || !(outpost >= 1 && outpost <= 4) || !/^Outpost_[A-Za-z]+$/.test(structure || "") || !(level >= 1))
            return res.status(400).json({ error: "missing_fields" });
        const profile = await ProfileModel.findOne({ accountId, profileId: "profile0" });
        if (!profile) return res.status(404).json({ error: "profile_not_found" });
        const stats = profile.stats.attributes;
        stats.limbo_outposts = stats.limbo_outposts || {};
        stats.limbo_outposts[outpost] = { ...(stats.limbo_outposts[outpost] || {}), [structure]: level };
        const spent = [];
        for (const { name, quantity } of Array.isArray(accountItems) ? accountItems : []) {
            const wanted = `accountresource.${String(name).toLowerCase()}`;
            const found = Object.entries(profile.items).find(([, item]) => item.templateId.toLowerCase() === wanted);
            if (!found || !(quantity > 0)) continue;
            found[1].quantity = Math.max(0, (found[1].quantity || 0) - quantity);
            profile.markModified(`items.${found[0]}`);
            spent.push(`${quantity} ${found[1].templateId}`);
        }
        profile.markModified("stats");
        profile.rvn += 1;
        profile.commandRevision += 1;
        await profile.save();
        console.log(`[OT6.5] ${accountId} upgraded ${structure} to level ${level} in outpost ${outpost}${spent.length ? `, spent ${spent.join(", ")}` : ""}`);
        res.json({ ok: true, level });
    });

    // A finished mission. On a win, the mission's rewards (and its mission alert's) go into the campaign profile; the
    // client gets them with its next profile call in the lobby. A won outpost (`outpost`: 1-4, the theater's) also
    // completes the player's open outpost quest there, which hands out its rewards and the next quests.
    app.post("/fortnite/api/game/v2/ot65/mission/end", async (req, res) => {
        if (!isLocal(req)) return res.status(403).json({ error: "local_only" });
        const { accountId, theaterId, missionGuid, victory, outpost } = req.body || {};
        if (!accountId || !theaterId || !missionGuid) return res.status(400).json({ error: "missing_fields" });
        if (!victory) return res.json({ granted: [], skipped: [] });

        const rewards = missionRewards(theaterId, missionGuid);
        if (!rewards) return res.status(404).json({ error: "mission_not_found" });
        const profile = await ProfileModel.findOne({ accountId, profileId: "profile0" });
        if (!profile) return res.status(404).json({ error: "profile_not_found" });

        const wrapper = new ProfileWrapper(profile);
        const granted = [], skipped = [];
        for (const reward of rewards) {
            const templateId = profileItemOf(reward.itemType);
            if (!templateId) {
                skipped.push(reward.itemType);
                continue;
            }
            wrapper.addQuantity(templateId, reward.quantity || 1);
            granted.push({ templateId, quantity: reward.quantity || 1 });
        }
        const outpostQuest = outpost > 0 && Object.values(profile.items)
            .filter((item) => new RegExp(`^Quest\\.outpostquest_t${outpost}_l\\d$`, "i").test(item.templateId) && item.attributes.quest_state === "Active")
            .map((item) => item.templateId).sort()[0];
        if (outpostQuest) {
            quests.completeQuest(profile, outpostQuest);
            granted.push({ templateId: outpostQuest, quantity: 1 });
        }
        if (granted.length) await profile.save();
        console.log(`[OT6.5] mission ${missionGuid} won by ${accountId}: granted ${JSON.stringify(granted)}, skipped ${JSON.stringify(skipped)}`);
        res.json({ granted, skipped });
    });
};
