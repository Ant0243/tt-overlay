const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

app.use(express.static(path.join(__dirname, "public")));

const rooms = new Map();

function freshState(room = "table1") {
    return {
        room,

        players: {
            A: "Joueur A",
            B: "Joueur B"
        },

        points: {
            A: 0,
            B: 0
        },

        sets: {
            A: 0,
            B: 0
        },

        bestOf: 5,             // 5 = 3 sets gagnants
        currentSet: 1,

        // mapping logique joueur -> côté affiché
        sides: {
            left: "A",
            right: "B"
        },

        // serveur logique (A ou B)
        firstServer: "A",
        server: "A",

        timeoutUsed: {
            A: false,
            B: false
        },

        timeoutActive: false,
        timeoutBy: "",

        history: []
    };
}

function getState(room) {
    if (!rooms.has(room)) rooms.set(room, freshState(room));
    return rooms.get(room);
}

function snapshot(st) {
    return JSON.parse(JSON.stringify({
        room: st.room,
        players: st.players,
        points: st.points,
        sets: st.sets,
        bestOf: st.bestOf,
        currentSet: st.currentSet,
        sides: st.sides,
        firstServer: st.firstServer,
        server: st.server,
        timeoutUsed: st.timeoutUsed,
        timeoutActive: st.timeoutActive,
        timeoutBy: st.timeoutBy
    }));
}

function pushHistory(st) {
    st.history.push(snapshot(st));
    if (st.history.length > 100) st.history.shift();
}

function neededToWin(bestOf) {
    return Math.ceil((Number(bestOf) || 5) / 2);
}

function recomputeServer(st) {
    const a = st.points.A || 0;
    const b = st.points.B || 0;
    const total = a + b;
    const deuce = a >= 10 && b >= 10;

    const base = st.firstServer === "B" ? "B" : "A";
    const other = base === "A" ? "B" : "A";

    let flips;
    if (!deuce) {
        flips = Math.floor(total / 2);
    } else {
        flips = total - 20;
    }

    st.server = (flips % 2 === 0) ? base : other;
}

function gameWon(p, o) {
    return p >= 11 && (p - o) >= 2;
}

function swapSides(st) {
    const tmp = st.sides.left;
    st.sides.left = st.sides.right;
    st.sides.right = tmp;
}

function resetPointsOnly(st) {
    st.points = { A: 0, B: 0 };
    st.timeoutActive = false;
    st.timeoutBy = "";
    recomputeServer(st);
}

function startNewSet(st) {
    st.currentSet += 1;

    // changement de côté à chaque set
    swapSides(st);

    // alternance du premier serveur
    st.firstServer = st.firstServer === "A" ? "B" : "A";

    st.points = { A: 0, B: 0 };
    st.timeoutActive = false;
    st.timeoutBy = "";
    recomputeServer(st);
}

function maybeSwapAtFiveInFinalSet(st) {
    const isFinalSet = st.bestOf === 5 && st.currentSet === 5;
    if (!isFinalSet) return;

    const totalA = st.points.A;
    const totalB = st.points.B;

    // swap une seule fois quand un joueur atteint 5
    if ((totalA === 5 || totalB === 5) && !st._swappedAtFive) {
        swapSides(st);
        st._swappedAtFive = true;
    }
}

function emitState(room) {
    io.to(room).emit("state", getState(room));
}

app.get("/debug", (req, res) => {
    const room = (req.query.room || "table1").toString();
    res.json(getState(room));
});

io.on("connection", (socket) => {
    socket.on("join", (room) => {
        room = (room || "table1").toString();
        socket.join(room);
        emitState(room);
    });

    socket.on("action", (msg) => {
        const room = (msg?.room || "table1").toString();
        const st = getState(room);
        const type = msg?.type || "";

        if (type === "UNDO") {
            const prev = st.history.pop();
            if (prev) {
                const hist = st.history;
                rooms.set(room, { ...prev, history: hist });
            }
            emitState(room);
            return;
        }

        pushHistory(st);

        if (type === "APPLY_SETTINGS") {
            const p = msg.payload || {};

            if (p.players) {
                st.players.A = (p.players.A || "Joueur A").toString().trim().slice(0, 24);
                st.players.B = (p.players.B || "Joueur B").toString().trim().slice(0, 24);
            }

            st.bestOf = Number(p.bestOf) || 5;
            st.firstServer = p.firstServer === "B" ? "B" : "A";
            st.server = st.firstServer;
            st.currentSet = 1;
            st.points = { A: 0, B: 0 };
            st.sets = { A: 0, B: 0 };
            st.sides = { left: "A", right: "B" };
            st.timeoutUsed = { A: false, B: false };
            st.timeoutActive = false;
            st.timeoutBy = "";
            st._swappedAtFive = false;
            recomputeServer(st);
        }

        else if (type === "SET_NAMES") {
            st.players.A = (msg.A || "Joueur A").toString().trim().slice(0, 24);
            st.players.B = (msg.B || "Joueur B").toString().trim().slice(0, 24);
        }

        else if (type === "SET_SERVE") {
            const serve = msg.serve === "B" ? "B" : "A";
            st.firstServer = serve;
            st.server = serve;
            st.points = { A: 0, B: 0 };
            st.timeoutActive = false;
            st.timeoutBy = "";
            recomputeServer(st);
        }

        else if (type === "POINT_A" || type === "POINT_B") {
            const who = type === "POINT_B" ? "B" : "A";
            const other = who === "A" ? "B" : "A";

            st.points[who] += 1;
            recomputeServer(st);

            maybeSwapAtFiveInFinalSet(st);

            if (gameWon(st.points[who], st.points[other])) {
                st.sets[who] += 1;

                const matchDone = st.sets[who] >= neededToWin(st.bestOf);
                if (!matchDone) {
                    startNewSet(st);
                } else {
                    // fin de match : on garde le score/sets jusqu’au reset manuel
                    st.timeoutActive = false;
                    st.timeoutBy = "";
                }
            }
        }

        else if (type === "RESET_POINTS" || type === "RESET_SCORE") {
            st.points = { A: 0, B: 0 };
            st.timeoutActive = false;
            st.timeoutBy = "";
            st._swappedAtFive = false;
            recomputeServer(st);
        }

        else if (type === "RESET_MATCH") {
            rooms.set(room, freshState(room));
            emitState(room);
            return;
        }

        else if (type === "TIMEOUT_START") {
            const by = msg.by === "B" ? "B" : "A";
            if (!st.timeoutUsed[by]) {
                st.timeoutUsed[by] = true;
                st.timeoutActive = true;
                st.timeoutBy = by;
            } else {
                st.history.pop();
            }
        }

        else if (type === "TIMEOUT_END") {
            st.timeoutActive = false;
            st.timeoutBy = "";
        }

        emitState(room);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
    console.log("Running on port " + PORT);
});