const { getItem, generateAttributes } = require("../../../util/gameData");
const ProfileWrapper = require("../../../util/ProfileWrapper");

module.exports = {
    name: "DeleteHero",
    handle: async (req, res, profile) => {
        const { heroId } = req.body;
        if (!heroId) return res.status(400).json({ error: "missing_hero_id" });

        const profileWrapper = new ProfileWrapper(profile);

        // If this hero was the equipped default commander, clear the reference so it doesn't dangle.
        if (profile.stats.attributes.defaultHeroId === heroId) {
            profileWrapper.updateStat("defaultHeroId", "", req.mcp.profileChanges);
        }

        profileWrapper.deleteItem(heroId, req.mcp.profileChanges);

        await profile.save();
    }
};