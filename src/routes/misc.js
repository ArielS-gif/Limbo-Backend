const fs = require('fs');
const path = require('path');

const worldInfo = require('../../common/world_info.json');
const catalog = require('../../common/catalog.json');

// OT6.5: world_info comes from a later build. More than half of its missions name a generator this 2016 client
// doesn't have (Plankerton's "T2" missions, Canny Valley's and Twine's rocket launches), and Play on those tiles did
// nothing. Each missing generator is served as the nearest one the client has, so every tile opens a mission. (The
// object is shared with the other routes that read world_info; only missionGenerator changes.)
const kClientGenerators = new Set(["1Gate", "2Gates", "3Gates", "4Gates", "DeliverTheGoods", "LaunchTheRocket", "PowerTheStormShield",
    "RetrieveTheData", "TheOutpost_PvE_01", "TheOutpost_PvE_02", "TheOutpost_PvE_03", "TheOutpost_PvE_04", "Onboarding_Fort"]);
const kNearestGenerator = [
    [/4Gates/, "4Gates"], [/3Gates/, "3Gates"], [/2Gates|EtSurvivors/, "2Gates"],
    [/RtD|RetrieveTheData/, "RetrieveTheData"],                      // Retrieve the Data
    [/RtL|LtR_|LaunchTheRocket/, "LaunchTheRocket"],                 // Ride the Lightning, the rocket launches
    [/DtB|DeliverTheGoods/, "DeliverTheGoods"],                      // Deliver the Bomb
    [/RtS|BuildtheRadarGrid|StormShield/, "PowerTheStormShield"],    // Repair the Shelter, Build the Radar Grid
];
const generatorPath = (name) => `/Game/World/MissionGens/MissionGen_${name}.MissionGen_${name}_C`;
{
    const served = {};
    for (const theater of worldInfo.missions || []) {
        for (const mission of theater.availableMissions || []) {
            const name = (mission.missionGenerator || "").split(".").pop().replace(/^MissionGen_|_C$/g, "");
            if (kClientGenerators.has(name)) continue;
            const nearest = (kNearestGenerator.find(([pattern]) => pattern.test(name)) || [null, "1Gate"])[1];
            mission.missionGenerator = generatorPath(nearest);
            served[`${name} -> ${nearest}`] = (served[`${name} -> ${nearest}`] || 0) + 1;
        }
    }
    const count = Object.values(served).reduce((a, b) => a + b, 0);
    if (count) console.log(`[OT6.5] ${count} mission(s) served with a generator this client has: ${Object.entries(served).map(([k, n]) => `${k} x${n}`).join(", ")}`);
}
// Limbo: no tile waits on anything (a few wait on outpost quests); the power locks go with the fully built homebase
// (util/homebase.js).
for (const theater of worldInfo.theaters || []) {
    for (const tile of theater.tiles || []) {
        tile.requirements = {
            ...tile.requirements,
            commanderLevel: 0, personalPowerRating: 0, partyPowerRating: 0,
            activeQuestDefinition: "None", questDefinition: "None", itemDefinition: "None",
            objectiveStatHandle: { dataTable: "None", rowName: "None" },
        };
    }
}

module.exports = (app) => {
    app.get('/fortnite/api/game/v2/world/info', (req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.write(JSON.stringify(worldInfo));
        res.end();
    });

    app.post('/fortnite/api/game/v2/world/validate', (req, res) => {
        const { theaterId, theaterMissionId, zoneThemeClass, worldId } = req.body;

        if (!theaterId || !theaterMissionId || !zoneThemeClass) return res.status(400).end();
        const theater = worldInfo.missions.find((theater) => theater.theaterId === theaterId);
        if (!theater) return res.status(404).end();

        const mission = theater.availableMissions.find((mission) => mission.missionGuid === theaterMissionId);
        if (!mission) return res.status(404).end();

        const missionData = {
            worldId,
            theaterId,
            theaterMissionId,
            zoneThemeClass,
            missionRewards: mission.missionRewards,
            missionGenerator: mission.missionGenerator,
            zoneDifficultyInfo: mission.missionDifficultyInfo,
            tileIndex: mission.tileIndex,
            zoneModifiers: []
        };

        res.json(missionData);
    });

    app.get('/fortnite/api/storefront/v2/catalog', (req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.write(JSON.stringify(catalog));
        res.end();
    });

    app.get("/fortnite/api/version", (req, res) => {
        res.json({
            app: "fortnite",
            serverDate: new Date().toISOString(),
            overridePropertiesVersion: "unknown",
            cln: "2870186",
            build: "1",
            moduleName: "Fortnite-Core",
            buildDate: "2016-02-17T11:16:51.000Z",
            version: "4.12.0-2870186+++Fortnite+Release-Live",
            branch: "++Fortnite+Release-Live",
            modules: {}
        })
    });

    app.get("/lightswitch/api/service/Fortnite/status", async (req, res) => {
        res.json({
            "serviceInstanceId": "fortnite",
            "status": "UP",
            "message": "Fortnite is online",
            "maintenanceUri": null,
            "overrideCatalogIds": [
                "a7f138b2e51945ffbfdacc1af0541053"
            ],
            "allowedActions": [],
            "banned": false,
            "launcherInfoDTO": {
                "appName": "Fortnite",
                "catalogItemId": "4fe75bbc5a674f4f9b356b5c90567da5",
                "namespace": "fn"
            }
        });
    });
    
    app.get("/lightswitch/api/service/bulk/status", async (req, res) => {
        res.json([{
            "serviceInstanceId": "fortnite",
            "status": "UP",
            "message": "fortnite is up.",
            "maintenanceUri": null,
            "overrideCatalogIds": [
                "a7f138b2e51945ffbfdacc1af0541053"
            ],
            "allowedActions": [
                "PLAY",
                "DOWNLOAD"
            ],
            "banned": false,
            "launcherInfoDTO": {
                "appName": "Fortnite",
                "catalogItemId": "4fe75bbc5a674f4f9b356b5c90567da5",
                "namespace": "fn"
            }
        }]);
    });

    app.get([
        "/account/api/epicdomains/ssodomains",
        "/fortnite/api/game/v2/enabled_features",
        "/account/api/public/account/:accountId/externalAuths",
        "/fortnite/api/game/v2/receipts/:accountId",
    ], (req, res) => {
        res.json([])
    });

    app.get([
        "/catalog/api/shared/bulk/offers",
    ], (req, res) => {
        res.json({})
    });

    app.get("/friends/api/public/list/fortnite/:accountId/recentPlayers", (req, res) => {
        res.json([])
    });

    app.get("/account", (req, res) => {
        res.status(200).end();
    });

    app.get("/fortnite", (req, res) => {
        res.status(200).end();
    });

    const debugET = true;
    app.post("/ET2/CollectData.1", (req, res) => {
        if (!debugET) return res.status(200).end();
        const { Events } = req.body;
        console.log("CollectData: ", Events.map(event => event.EventName).join(", "));

        res.status(200).end();
    });
}