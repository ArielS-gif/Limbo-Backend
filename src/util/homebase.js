// Limbo: every player's homebase is fully built (each building the game shows at its top level), which puts the power
// level at its highest, so every mission on the Play tab can be started.
const { getAllItems } = require('./gameData');

const kTopLevels = Object.fromEntries(getAllItems("MyFortBuilding")
    .filter((item) => !item.Properties?.bHideInUI)
    .map((item) => [item.templateId, (item.Properties?.StaticGameplayEffectsByLevel || []).length])
    .filter(([, levels]) => levels > 0));

// The homebase tutorial has the player build one of these (and recruit a hero there), so they wait until it's done.
const kTutorialBuildings = ["MyFortBuilding.Building_MilitaryHQ", "MyFortBuilding.Building_TechLab"];

function tutorialBuildsOne(profile) {
    const quest = Object.values(profile.items).find((item) => item.templateId === "Quest.homebaseonboarding");
    return Boolean(quest) && !quest.attributes.completion_hbonboarding_buildherobuilding;
}

// Builds and tops out the profile's buildings; true when something changed.
function maxOutBuildings(profile) {
    const waiting = tutorialBuildsOne(profile) ? kTutorialBuildings : [];
    let changed = false;

    for (const item of Object.values(profile.items)) {
        const topLevel = kTopLevels[item.templateId];
        if (!topLevel || waiting.includes(item.templateId)) continue;
        if (item.attributes.level >= topLevel && item.attributes.buildingState === "Idle") continue;

        item.attributes.level = topLevel;
        item.attributes.buildingState = "Idle";
        changed = true;
    }

    return changed;
}

// The same for an account that was made before this.
async function maxOut(accountId) {
    const ProfileModel = require('../model/profile');
    const profile = await ProfileModel.findOne({ accountId, profileId: "profile0" });
    if (profile && maxOutBuildings(profile)) await profile.save();
}

module.exports = { maxOutBuildings, maxOut };
