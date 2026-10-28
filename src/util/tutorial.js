// Limbo: the tutorial is each player's choice. To the game it is the Onboarding quests: the homebase's (name the home
// base, build the hero building, recruit a hero), the first outpost's (Stonewood's first storm shield defense) and the
// one after it. While any is open, Ray's "Getting Started" leads the way and the Friends list stays locked (the quest
// manager's bTutorialCompleted). Play Limbo.bat asks the player and tells the backend they play on (POST
// ot65/tutorial/skip or /play, from the player's own PC); the choice is kept per address, and when that player logs in
// an account still in the tutorial is moved past it: what playing it would have left behind is put in place.
const ProfileModel = require("../model/profile");
const ProfileWrapper = require("./ProfileWrapper");
const { completeQuest } = require("./quests");
const { generateAttributes } = require("./gameData");
const homebase = require("./homebase");

// In the order they come: finishing the first outpost's quest gives the one after it (and the outpost's next quests).
const kOnboarding = ["Quest.homebaseonboarding", "Quest.outpostquest_t1_l1", "Quest.homebaseonboardingafteroutpost"];

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
    return Object.values(profile.items).some((item) =>
        kOnboarding.includes(String(item.templateId).toLowerCase().replace(/^quest\./, "Quest.")) && item.attributes.quest_state !== "Claimed");
}

// A quest done and claimed, as the game would leave it: completeQuest gives its rewards (the next quests among them).
function claim(profile, templateId) {
    const wrapper = new ProfileWrapper(profile);
    const quest = wrapper.findTemplateId(templateId);
    if (!quest || quest.value.attributes.quest_state === "Claimed") return;
    completeQuest(profile, templateId);
    wrapper.updateAttribute(quest.key, "quest_state", "Claimed");
    wrapper.updateAttribute(quest.key, "state", "Claimed");
}

// What finishing the tutorial leaves: its quests claimed (with the first outpost's rewards and next quests), a named
// home base, recruited heroes (the Commando the default), the tutorial's gameplay stats, and the buildings that waited
// for it.
function skip(profile, username) {
    const wrapper = new ProfileWrapper(profile);
    for (const templateId of kOnboarding) claim(profile, templateId);

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

// At login: an account still in the tutorial skips (the rest of) it when its player chose that.
async function applyChoice(req, user) {
    if (g_skip.get(clientIp(req)) !== true) return;
    const profile = await ProfileModel.findOne({ accountId: user.accountId, profileId: "profile0" });
    if (!profile || !inTutorial(profile)) return;
    skip(profile, user.username);
    profile.rvn += 1;
    await profile.save();
    console.log(`[Limbo] ${user.username} skipped the tutorial (the homebase and the first outpost)`);
}

module.exports = { setChoice, applyChoice, skip };
