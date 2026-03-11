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
        players: { A: "Joueur A", B: "Joueur B" },
        points: { A: 0, B: 0 },
        sets: { A: 0, B: 0 },
        bestOf: 5,              // best of 5 = 3 sets gagnants
        firstServer: "A",       // serveur initial du set
        server: "A",            // serveur courant
        timeoutUsed: { A: false, B: false },
        timeoutActive: false,
        timeoutBy: "",
        currentSet: 1,
        history: []
    };
}

function getState(room) {
    if (!rooms.has(room)) {
        rooms.set(room, freshState(room));
    }
    return rooms.get(room);
}

function snapshot(st) {
    return JSON.parse(JSON.stringify({
        room: st.room,
        players: st.players,
        points: st.points,
        sets: st.sets,
        bestOf: st.bestOf,
        firstServer: st.firstServer,
        server: st.server,
        timeoutUsed: st.timeoutUsed,
        timeoutActive: st.timeoutActive,
        timeoutBy: st.timeoutBy,
        currentSet: st.currentSet
    }));
}

function pushHistory(st) {
    st.history.push(snapshot(st));
    if (st.history.length > 100) st.history.shift();
}

function neededToWin(bestOf) {
    return Math.ceil((Number(bestOf) || 5) / 2);
}

// Service ping : tous les 2 points, puis à 10-10 tous les 1 point
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

function resetPointsOnly(st) {
    st.points = { A: 0, B: 0 };
    st.timeoutActive = false;
    st.timeoutBy = "";
    recomputeServer(st);
}

function nextSet(st) {
    st.currentSet += 1;
    st.points = { A: 0, B: 0 };
    st.timeoutActive = false;
    st.timeoutBy = "";
    st.firstServer = st.firstServer === "A" ? "B" : "A";
    recomputeServer(st);
}

function emitState(room) {
    io.to(room).emit("state", getState(room));
}

// pratique pour voir l’état dans le navigateur
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
        const payload = msg?.payload || {};

        // Undo
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

        // Réglages globaux
        if (type === "APPLY_SETTINGS") {
            if (payload.players) {
                st.players.A = (payload.players.A || "Joueur A").toString().trim().slice(0, 24);
                st.players.B = (payload.players.B || "Joueur B").toString().trim().slice(0, 24);
            }
            if (payload.bestOf) {
                st.bestOf = Number(payload.bestOf) || 5;
            }
            if (payload.firstServer === "A" || payload.firstServer === "B") {
                st.firstServer = payload.firstServer;
            }
            st.currentSet = 1;
            st.sets = { A: 0, B: 0 };
            st.timeoutUsed = { A: false, B: false };
            resetPointsOnly(st);
        }

        // Noms
        else if (type === "SET_NAMES") {
            st.players.A = (msg.A || payload.A || "Joueur A").toString().trim().slice(0, 24);
            st.players.B = (msg.B || payload.B || "Joueur B").toString().trim().slice(0, 24);
        }

        // 1er service
        else if (type === "SET_SERVE") {
            const serve = (msg.serve || payload.serve) === "B" ? "B" : "A";
            st.firstServer = serve;
            resetPointsOnly(st);
        }

        // Reset points
        else if (type === "RESET_POINTS" || type === "RESET_SCORE") {
            resetPointsOnly(st);
        }

        // Reset match
        else if (type === "RESET_MATCH") {
            rooms.set(room, freshState(room));
            emitState(room);
            return;
        }

        // Temps mort ON direct
        else if (type === "TIMEOUT_START") {
            const by = (msg.by || payload.by) === "B" ? "B" : "A";
            if (!st.timeoutUsed[by]) {
                st.timeoutUsed[by] = true;
                st.timeoutActive = true;
                st.timeoutBy = by;
            } else {
                st.history.pop();
            }
        }

        // Fin temps mort
        else if (type === "TIMEOUT_END") {
            st.timeoutActive = false;
            st.timeoutBy = "";
        }

        // Ancien format : TAKE_TO_A / TAKE_TO_B
        else if (type === "TAKE_TO_A") {
            if (!st.timeoutUsed.A) {
                st.timeoutUsed.A = true;
                st.timeoutActive = true;
                st.timeoutBy = "A";
            } else {
                st.history.pop();
            }
        }

        else if (type === "TAKE_TO_B") {
            if (!st.timeoutUsed.B) {
                st.timeoutUsed.B = true;
                st.timeoutActive = true;
                st.timeoutBy = "B";
            } else {
                st.history.pop();
            }
        }

        // Toggle timeout
        else if (type === "TOGGLE_TIMEOUT") {
            const who = (payload.who || msg.by || "A") === "B" ? "B" : "A";

            if (st.timeoutActive) {
                if (st.timeoutBy === who) {
                    st.timeoutActive = false;
                    st.timeoutBy = "";
                } else {
                    st.history.pop();
                }
            } else {
                if (!st.timeoutUsed[who]) {
                    st.timeoutUsed[who] = true;
                    st.timeoutActive = true;
                    st.timeoutBy = who;
                } else {
                    st.history.pop();
                }
            }
        }

        // Points : ancien format POINT_A / POINT_B
        else if (type === "POINT_A" || type === "POINT_B") {
            const who = type === "POINT_B" ? "B" : "A";
            const other = who === "A" ? "B" : "A";

            st.points[who] += 1;
            recomputeServer(st);

            if (gameWon(st.points[who], st.points[other])) {
                st.sets[who] += 1;

                const winNeed = neededToWin(st.bestOf);
                if (st.sets[who] < winNeed) {
                    nextSet(st);
                } else {
                    // match fini : on repart quand même à 0-0 visuellement pour le set suivant si tu veux
                    // ici je laisse le dernier set validé visible 1 instant puis reset du set
                    nextSet(st);
                }
            }
        }

        // Points : nouveau format POINT + payload.who
        else if (type === "POINT") {
            const who = (payload.who === "B") ? "B" : "A";
            const other = who === "A" ? "B" : "A";

            st.points[who] += 1;
            recomputeServer(st);

            if (gameWon(st.points[who], st.points[other])) {
                st.sets[who] += 1;

                const winNeed = neededToWin(st.bestOf);
                if (st.sets[who] < winNeed) {
                    nextSet(st);
                } else {
                    nextSet(st);
                }
            }
        }

        emitState(room);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
    console.log("Running on port " + PORT);
});