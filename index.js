// vops - 2024

require('dotenv-safe').config();
require('./src/util/gameData');

const http = require('http');
const express = require('express');

process.on('uncaughtException', console.error);
process.on('unhandledRejection', console.error);

const app = express();
require('./src/db').open();
require('./src/express')(app);

const server = http.createServer(app);
const port = process.env.PORT || 3551;

server.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});

// OT6.5: chat and presence for the game (XMPP, port 5222).
require('./src/xmpp')();
// Limbo: friends' Play Limbo.bat finds this backend on the network (UDP, the same port).
require('./src/discovery')(Number(port));