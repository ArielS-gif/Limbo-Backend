// Limbo: the homebase tutorial (name the home base, build the hero building, recruit a hero) is each player's choice.
// Play Limbo.bat asks it and tells the backend the player plays on (POST ot65/tutorial/skip or /play, from the
// player's own PC); the choice is kept per address, and when that player logs in an account still in the tutorial
// is moved past it: what the tutorial would have left behind is put in place.
const ProfileModel = require("../model/profile");
const ProfileWrapper = require("./ProfileWrapper");
const { completeQuest } = require("./quests");
const { generateAttributes } = require("./gameData");
const homebase = require("./homebase");

// The four heroes of this build, as the tutorial's recruit step makes them (level 20).
const kHeroes = [
    { templateId: "Hero.class_commando", name: "Sam \"Ace\" Torres", gender: 1 },
    { templateId: "Hero.class_constructor", name: "Maya \"Rivet\" Brooks", gender: 2 },
    { templateId: "Hero.class_ninja", name: "Ken \"Shade\" Ito", gender: 1 },
    { templateId: "Hero.class_outlander", name: "Rae \"Scout\" Lin", gender: 2 },
];

const g_skip = new Map();  // player's address -> true (skip) / false (play it)

function clientIp(req) {
    return (req.socket.remoteAddress || "").replace(/^::ffff:/, "");
}

function setChoice(req, skip) {
    g_skip.set(clientIp(req), skip);
}

function inTutorial(profile) {
    const quest = Object.values(profile.items).find((item) => item.templateId === "Quest.homebaseonboarding");
    return Boolean(quest) && quest.attributes.quest_state !== "Claimed";
}

// What finishing the tutorial leaves: the quest claimed, a named home base, recruited heroes (the Commando the
// default), the tutorial's gameplay stats, and the buildings that waited for it.
function skip(profile, username) {
    const wrapper = new ProfileWrapper(profile);
    completeQuest(profile, "Quest.homebaseonboarding");

    const stats = profile.stats.attributes;
    if (!stats.homebase || !stats.homebase.townName)
        wrapper.updateStat("homebase", { townName: `${username}'s Base`, flagPattern: 0, flagColor: 0 });

    let commando = null;
    for (const hero of kHeroes) {
        const have = wrapper.findTemplateId(hero.templateId);
        if (have) {
            if (hero.templateId === "Hero.class_commando") commando = have.key;
            continue;
        }
        const attributes = generateAttributes(hero.templateId);
        Object.assign(attributes, { hero_name: hero.name, gender: hero.gender, level: 20, mode_loadouts: [] });
        const key = wrapper.addItem({ templateId: hero.templateId, attributes, quantity: 1 });
        if (hero.templateId === "Hero.class_commando") commando = key;
    }
    if (!profile.items[stats.defaultHeroId] && commando) wrapper.updateStat("defaultHeroId", commando);

    const gameplay = Array.isArray(stats.gameplay_stats) ? stats.gameplay_stats.slice() : [];
    for (const [statName, statValue] of [["homebase_personalized", 1], ["homebase_builtbuilding", 1], ["homebase_recruitedhero", kHeroes.length]])
        if (!gameplay.some((s) => s.statName === statName)) gameplay.push({ statName, statValue });
    wrapper.updateStat("gameplay_stats", gameplay);

    homebase.maxOutBuildings(profile);
}

// At login: an account still in the tutorial skips it when its player chose that.
async function applyChoice(req, user) {
    if (g_skip.get(clientIp(req)) !== true) return;
    const profile = await ProfileModel.findOne({ accountId: user.accountId, profileId: "profile0" });
    if (!profile || !inTutorial(profile)) return;
    skip(profile, user.username);
    profile.rvn += 1;
    await profile.save();
    console.log(`[Limbo] ${user.username} skipped the homebase tutorial`);
}

module.exports = { setChoice, applyChoice, skip };
