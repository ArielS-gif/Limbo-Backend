// OT6.5: the game's chat and presence service (XMPP over TCP, as the 2016 client's libjingle speaks it). Without it
// the main menu's chat says "Unable to chat while offline" and the social corner stays on "Connecting...". The patch
// pak points [OnlineSubsystemMcp.XMPP] at this machine's port 5222, without TLS.
//
// Login: SASL PLAIN with the account id and the game's access token (checked like the HTTP routes check it). Then
// resource binding and a session, the roster (every other account, so friends' presence and whispers work), presence
// to everyone online, chat rooms (multi-user chat: the GLOBAL channel and the party's) and private messages.
const net = require("net");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const UserModel = require("./model/user");

const kPort = Number(process.env.XMPP_PORT || 5222);
const kDomain = "prod.ol.epicgames.com";
const kMucDomain = `muc.${kDomain}`;
const kLogStanzas = 40;  // the first stanzas of each kind are logged, to see what the client asks for

const clients = new Set();  // logged-in, bound connections
const rooms = new Map();    // room jid (bare) -> Map(nick -> client)
const seenKinds = new Map();

// ---- a small XML stream parser: the stream's opening tag, then whole top-level elements (stanzas) ---------------

function decode(text) {
    return text.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, e) => {
        const named = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" }[e.toLowerCase()];
        if (named) return named;
        return String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    });
}

function escape(text) {
    return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function parseAttrs(text) {
    const attrs = {};
    for (const m of text.matchAll(/([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) attrs[m[1]] = decode(m[3] !== undefined ? m[3] : m[4]);
    return attrs;
}

class Parser {
    constructor(onStreamStart, onStanza, onStreamEnd) {
        this.buffer = "";
        this.stack = [];
        this.onStreamStart = onStreamStart;
        this.onStanza = onStanza;
        this.onStreamEnd = onStreamEnd;
    }

    push(chunk) {
        this.buffer += chunk;
        for (;;) {
            if (!this.stack.length) {  // between stanzas: skip whitespace
                const lt = this.buffer.indexOf("<");
                if (lt < 0) { this.buffer = ""; return; }
                this.buffer = this.buffer.slice(lt);
            } else if (this.buffer[0] !== "<") {  // text inside an element
                const lt = this.buffer.indexOf("<");
                if (lt < 0) return;
                const top = this.stack[this.stack.length - 1];
                top.text += decode(this.buffer.slice(0, lt));
                this.buffer = this.buffer.slice(lt);
            }
            const gt = this.buffer.indexOf(">");
            if (gt < 0) return;
            const tag = this.buffer.slice(1, gt);
            this.buffer = this.buffer.slice(gt + 1);
            if (tag.startsWith("?") || tag.startsWith("!")) continue;  // <?xml ...?>, comments
            if (tag.startsWith("/")) {
                const name = tag.slice(1).trim();
                if (name === "stream:stream") { this.onStreamEnd(); continue; }
                const element = this.stack.pop();
                if (!element) continue;
                if (this.stack.length) this.stack[this.stack.length - 1].children.push(element);
                else this.onStanza(element);
                continue;
            }
            const selfClosing = tag.endsWith("/");
            const body = selfClosing ? tag.slice(0, -1) : tag;
            const space = body.search(/\s/);
            const name = space < 0 ? body : body.slice(0, space);
            const element = { name, attrs: parseAttrs(space < 0 ? "" : body.slice(space)), children: [], text: "" };
            if (name === "stream:stream") { this.onStreamStart(element); continue; }
            if (selfClosing) {
                if (this.stack.length) this.stack[this.stack.length - 1].children.push(element);
                else this.onStanza(element);
            } else {
                this.stack.push(element);
            }
        }
    }
}

function child(element, name) {
    return element.children.find((c) => c.name === name || c.name.endsWith(":" + name));
}

function serialize(element) {
    const attrs = Object.entries(element.attrs).map(([k, v]) => ` ${k}="${escape(v)}"`).join("");
    const inner = escape(element.text || "") + element.children.map(serialize).join("");
    return inner ? `<${element.name}${attrs}>${inner}</${element.name}>` : `<${element.name}${attrs}/>`;
}

// ---- connections -------------------------------------------------------------------------------------------------

function bare(jid) {
    return String(jid || "").split("/")[0];
}

function logStanza(client, element) {
    const kind = `${element.name} ${element.attrs.type || ""} ${element.children.map((c) => c.attrs.xmlns || c.name).join(",")}`;
    const count = (seenKinds.get(kind) || 0) + 1;
    seenKinds.set(kind, count);
    if (process.env.LIMBO_XMPP_TRACE) console.log(`[XMPP] ${client.accountId || "?"} -> ${serialize(element).slice(0, 4000)}`);  // everything
    else if (count <= 3 && seenKinds.size <= kLogStanzas) console.log(`[XMPP] ${client.accountId || "?"} -> ${serialize(element).slice(0, 400)}`);
}

function send(client, xml) {
    if (!client.socket.destroyed) client.socket.write(xml);
}

function presenceOf(client, to, type) {
    const element = { name: "presence", attrs: { from: client.jid, to }, children: [], text: "" };
    if (type) element.attrs.type = type;
    else for (const c of client.presence?.children || []) element.children.push(c);
    return serialize(element);
}

function broadcastPresence(client, type) {
    for (const other of clients) if (other !== client && other.jid) send(other, presenceOf(client, other.jid, type));
}

function leaveRooms(client) {
    for (const [room, occupants] of rooms) {
        for (const [nick, occupant] of occupants) {
            if (occupant !== client) continue;
            occupants.delete(nick);
            for (const other of occupants.values())
                send(other, `<presence from="${escape(`${room}/${nick}`)}" to="${escape(other.jid)}" type="unavailable"><x xmlns="http://jabber.org/protocol/muc#user"><item affiliation="none" role="none"/></x></presence>`);
        }
        if (!occupants.size) rooms.delete(room);
    }
}

function handleRoomPresence(client, element) {
    const to = element.attrs.to;
    const room = bare(to), nick = to.slice(room.length + 1) || client.accountId;
    if (!rooms.has(room)) rooms.set(room, new Map());
    const occupants = rooms.get(room);
    if (element.attrs.type === "unavailable") {
        occupants.delete(nick);
        send(client, `<presence from="${escape(to)}" to="${escape(client.jid)}" type="unavailable"><x xmlns="http://jabber.org/protocol/muc#user"><item affiliation="none" role="none"/><status code="110"/></x></presence>`);
        for (const other of occupants.values())
            send(other, `<presence from="${escape(to)}" to="${escape(other.jid)}" type="unavailable"><x xmlns="http://jabber.org/protocol/muc#user"><item affiliation="none" role="none"/></x></presence>`);
        if (!occupants.size) rooms.delete(room);
        return;
    }
    const item = (who, occupantJid) => `<x xmlns="http://jabber.org/protocol/muc#user"><item affiliation="member" role="participant" jid="${escape(occupantJid)}"/>${who}</x>`;
    for (const [otherNick, other] of occupants)  // who is already there, to the newcomer
        if (other !== client) send(client, `<presence from="${escape(`${room}/${otherNick}`)}" to="${escape(client.jid)}">${item("", other.jid)}</presence>`);
    occupants.set(nick, client);
    for (const other of occupants.values())  // the newcomer, to everyone (to itself with status 110)
        send(other, `<presence from="${escape(to)}" to="${escape(other.jid)}">${item(other === client ? '<status code="110"/>' : "", client.jid)}</presence>`);
    console.log(`[XMPP] ${client.accountId} joined ${room} as ${nick} (${occupants.size} in it)`);
}

function handleMessage(client, element) {
    const to = element.attrs.to || "";
    const body = child(element, "body");
    if (element.attrs.type === "groupchat") {
        const occupants = rooms.get(bare(to));
        if (!occupants) return;
        const nick = [...occupants].find(([, c]) => c === client)?.[0];
        if (!nick) return;
        for (const other of occupants.values()) {
            const message = { ...element, attrs: { ...element.attrs, from: `${bare(to)}/${nick}`, to: other.jid } };
            send(other, serialize(message));
        }
        if (body) console.log(`[XMPP] ${bare(to)} <${nick}> ${body.text.slice(0, 200)}`);
        return;
    }
    // A private message: to every connection of that account (or a room occupant's real connection).
    let targets = [...clients].filter((c) => c.jid === to || bare(c.jid) === bare(to));
    if (!targets.length && to.includes("@" + kMucDomain)) {
        const occupant = rooms.get(bare(to))?.get(to.slice(bare(to).length + 1));
        if (occupant) targets = [occupant];
    }
    for (const target of targets) send(target, serialize({ ...element, attrs: { ...element.attrs, from: client.jid, to: target.jid } }));
}

function handleIq(client, element) {
    const id = element.attrs.id || "";
    const query = element.children[0];
    const ns = query?.attrs.xmlns || "";
    const result = (inner = "") => send(client, `<iq type="result" id="${escape(id)}" to="${escape(client.jid || "")}" from="${kDomain}">${inner}</iq>`);
    if (element.attrs.type === "result" || element.attrs.type === "error") return;
    if (ns === "urn:ietf:params:xml:ns:xmpp-bind") {
        const resource = child(query, "resource")?.text || `ot65-${crypto.randomBytes(4).toString("hex")}`;
        client.jid = `${client.accountId}@${kDomain}/${resource}`;
        clients.add(client);
        result(`<bind xmlns="urn:ietf:params:xml:ns:xmpp-bind"><jid>${escape(client.jid)}</jid></bind>`);
        console.log(`[XMPP] ${client.accountId} (${client.name}) is online as ${client.jid}`);
        return;
    }
    if (ns === "urn:ietf:params:xml:ns:xmpp-session" || ns === "urn:xmpp:ping") return result();
    if (ns === "jabber:iq:roster") {
        // Everyone else who has an account here is a friend (a private server among friends).
        UserModel.find({}, { accountId: 1, username: 1 }).lean().then((users) => {
            const items = users.filter((u) => u.accountId !== client.accountId)
                .map((u) => `<item jid="${escape(`${u.accountId}@${kDomain}`)}" name="${escape(u.username)}" subscription="both"/>`).join("");
            result(`<query xmlns="jabber:iq:roster">${items}</query>`);
        }).catch(() => result(`<query xmlns="jabber:iq:roster"/>`));
        return;
    }
    if (element.attrs.to && element.attrs.to.endsWith(kMucDomain)) return result(query ? serialize(query) : "");  // room config and the like
    // Anything else: an empty result rather than an error, so the client carries on.
    result();
}

function handleStanza(client, element) {
    logStanza(client, element);
    if (!client.authenticated) {
        if (element.name === "auth") return authenticate(client, element);
        return;
    }
    if (element.name === "iq") return handleIq(client, element);
    if (element.name === "message") return handleMessage(client, element);
    if (element.name === "presence") {
        if (element.attrs.to && bare(element.attrs.to).endsWith("@" + kMucDomain)) return handleRoomPresence(client, element);
        if (element.attrs.to) return;  // subscriptions: everyone is subscribed already
        client.presence = element;
        const away = element.attrs.type === "unavailable";
        broadcastPresence(client, away ? "unavailable" : "");
        if (!away && !client.sawOthers) {  // the others' presence, once, after the first one
            client.sawOthers = true;
            for (const other of clients) if (other !== client && other.presence && other.jid) send(client, presenceOf(other, client.jid, ""));
        }
    }
}

function authenticate(client, element) {
    const parts = Buffer.from(element.text || "", "base64").toString("utf8").split("\0");
    const user = parts[1] || "", password = parts[2] || "";
    const accountId = user.split("@")[0];
    let ok = false;
    try {
        const decoded = jwt.verify(password.replace(/^bearer /i, "").replace(/^eg1~/, ""), process.env.JWT_SECRET);
        ok = decoded && (decoded.sub === accountId || !accountId);
        client.accountId = decoded.sub;
    } catch (e) {
        ok = false;
    }
    if (!ok) {
        console.log(`[XMPP] login refused for ${accountId || "?"} (the token didn't check out)`);
        send(client, `<failure xmlns="urn:ietf:params:xml:ns:xmpp-sasl"><not-authorized/></failure>`);
        return;
    }
    client.authenticated = true;
    UserModel.findOne({ accountId: client.accountId }).lean().then((u) => { client.name = u?.username || client.accountId; });
    send(client, `<success xmlns="urn:ietf:params:xml:ns:xmpp-sasl"/>`);
}

function openStream(client) {
    const id = crypto.randomBytes(8).toString("hex");
    send(client, `<?xml version="1.0"?><stream:stream xmlns="jabber:client" xmlns:stream="http://etherx.jabber.org/streams" id="${id}" from="${kDomain}" version="1.0" xml:lang="en">`);
    if (!client.authenticated) {
        send(client, `<stream:features><mechanisms xmlns="urn:ietf:params:xml:ns:xmpp-sasl"><mechanism>PLAIN</mechanism></mechanisms></stream:features>`);
    } else {
        send(client, `<stream:features><bind xmlns="urn:ietf:params:xml:ns:xmpp-bind"/><session xmlns="urn:ietf:params:xml:ns:xmpp-session"/></stream:features>`);
    }
}

function close(client) {
    if (client.closed) return;
    client.closed = true;
    if (client.jid) {
        leaveRooms(client);
        broadcastPresence(client, "unavailable");
        clients.delete(client);
        console.log(`[XMPP] ${client.accountId} went offline`);
    }
    if (!client.socket.destroyed) client.socket.destroy();
}

module.exports = () => {
    const server = net.createServer((socket) => {
        socket.setEncoding("utf8");
        socket.setKeepAlive(true, 30000);
        const client = { socket, authenticated: false, accountId: "", name: "", jid: "", presence: null };
        const parser = new Parser(() => openStream(client), (element) => {
            try {
                handleStanza(client, element);
            } catch (e) {
                console.error("[XMPP]", e);
            }
        }, () => {
            send(client, "</stream:stream>");
            close(client);
        });
        socket.on("data", (data) => parser.push(data));
        socket.on("close", () => close(client));
        socket.on("error", () => close(client));
    });
    server.on("error", (e) => console.error(`[XMPP] can't listen on ${kPort}: ${e.message}`));
    server.listen(kPort, () => console.log(`XMPP (chat and presence) is running on port ${kPort}`));
};

// The names of the players online (logged in to chat), for the network discovery's answer.
module.exports.online = () => [...new Set([...clients].map((client) => client.name).filter(Boolean))];
