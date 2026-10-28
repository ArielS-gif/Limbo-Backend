// Limbo: finding this backend on the network. Play Limbo.bat (Limbo's tools/discover.js) broadcasts "LIMBO?" to UDP
// 3551 on every network the PC is on (a LAN, Radmin VPN's 26.x); this answers with the backend's port, the PC's name and
// who is playing, so a friend's game finds it without anyone typing an address.
const dgram = require("dgram");
const os = require("os");
const xmpp = require("./xmpp");

module.exports = (port) => {
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    socket.on("message", (message, from) => {
        if (message.toString() !== "LIMBO?") return;
        socket.send(JSON.stringify({ limbo: 1, port, name: os.hostname(), online: xmpp.online() }), from.port, from.address);
    });
    socket.on("error", (e) => console.error(`[Limbo] friends can't find this backend on the network (UDP ${port}): ${e.message}`));
    socket.bind(port, () => console.log(`Friends on the network find this backend (UDP ${port})`));
};
