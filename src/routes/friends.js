const UserModel = require('../model/user');
const { verifyToken } = require("../util/middleware");

module.exports = (app) => {
    // Limbo: everyone with an account here is everyone's friend (a private server among friends; the chat roster in
    // xmpp.js says the same), so the game's Friends list shows them, with their presence.
    app.get("/friends/api/public/friends/:accountId", verifyToken, async (req, res) => {
        if (req.params.accountId !== req.user.accountId) return res.status(403).json({ error: "forbidden" });
        const users = await UserModel.find({}, { accountId: 1, username: 1, isDedicated: 1 }).lean();
        res.json(users.filter((u) => u.accountId !== req.user.accountId && !u.isDedicated).map((u) => ({
            accountId: u.accountId,
            status: "ACCEPTED",
            direction: "OUTBOUND",
            created: "2016-02-17T00:00:00.000Z",
            favorite: false,
        })));
    });

    app.get("/friends/api/public/blocklist/:accountId", (req, res) => {
        res.json({ blockedUsers: [] });
    });
};