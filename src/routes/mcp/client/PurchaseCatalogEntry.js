const { getItem, generateAttributes } = require("../../../util/gameData");
const ProfileWrapper = require("../../../util/ProfileWrapper");
const catalog = require("../../../../common/catalog.json");

module.exports = {
    name: "PurchaseCatalogEntry",
    handle: async (req, res, profile) => {
        const { offerId, purchaseQuantity, currency, currencySubType } = req.body;
        if (!offerId) return res.status(400).send({ error: "Invalid request body" });
        const qty = purchaseQuantity || 1;
        // The client sends the expected total as "expectedTotalPrice"; accept "expectedPrice" too, just in case.
        const expected = req.body.expectedTotalPrice ?? req.body.expectedPrice;
        // todo: validate body some stuff might be optional (?)

        let offer;

        for (const storefront of catalog.storefronts) {
            for (const item of storefront.catalogEntries) {
                if (item.offerId === offerId) {
                    offer = item;
                    break;
                }
            }
        }

        if (!offer) return res.status(404).send({ error: "Offer not found" });

        const requestedPrice = offer.prices.find(p => p.currencyType === currency && p.currencySubType === currencySubType);
        if (!requestedPrice) return res.status(400).send({ error: "Invalid currency" });

        const { itemGrants } = offer;

        const profileWrapper = new ProfileWrapper(profile);
        

        switch (requestedPrice.currencyType) {
            case "MtxCurrency":
                const cost = requestedPrice.finalPrice * qty;
                if (expected !== cost) return res.status(400).send({ error: "Invalid price" });
                const userCurrency = profileWrapper.getMtx();
                if (userCurrency < cost) return res.status(400).send({ error: "Not enough currency" });
                
                profileWrapper.removeMtx(cost, req.mcp.profileChanges);
                break;
            default:
                return res.status(400).send({ error: "Invalid currency" });
        }

        for (const itemGrant of itemGrants) {
            profileWrapper.addQuantity(itemGrant.templateId, itemGrant.quantity * qty, req.mcp.profileChanges);
        }

        await profile.save();
    }
};