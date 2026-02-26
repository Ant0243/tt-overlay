const WebSocket = require("ws");
const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
app.use(express.static("public"));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const port = process.env.PORT || 8787;

server.listen(port, () => {
    console.log("Serveur en ligne sur port", port);
});

/* =============================
   INITIAL STATE
============================= */

function createInitialState() {
    return {
        mode: "singles",

        A1: "JOUEUR A",
        A2: "",
        B1: "JOUEUR B",
        B2: "",

        pointsA: 0,
        pointsB: 0,
        setsA: 0,
        setsB: 0,

        bestOf: 5,

        server: "A",               // serveur actuel
        firstServerOfSet: "A",     // mémorise qui commence chaque set

        timeoutUsedA: false,
        timeoutUsedB: false,
        timeoutActive: false,

        matchPointFor: null,
        finished: false,

        pointHistory: []
    };
}

let state = createInitialState();
let undoStack = [];
const UNDO_LIMIT = 200;

/* =============================
   UTILS
============================= */

function snapshot() {
    return JSON.parse(JSON.stringify(state));
}

function pushUndo(reason) {
    undoStack.push({ reason, s: snapshot() });
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
}

function neededSets() {
    return Math.ceil(state.bestOf / 2);
}

function broadcast() {
    const data = JSON.stringify(state);
    wss.clients.forEach(c => {
        if (c.readyState === WebSocket.OPEN) c.send(data);
    });
}

function switchServer() {
    state.server = state.server === "A" ? "B" : "A";
}

/* =============================
   MATCH POINT LOGIC
============================= */

function computeMatchPoint() {
    state.matchPointFor = null;
    if (state.finished) return;

    const target = neededSets();

    const aLastSet = state.setsA === target - 1;
    const bLastSet = state.setsB === target - 1;

    if (aLastSet) {
        const setAlreadyWon =
            state.pointsA >= 11 &&
            (state.pointsA - state.pointsB) >= 2;

        if (!setAlreadyWon &&
            state.pointsA >= 10 &&
            state.pointsA > state.pointsB
        ) {
            state.matchPointFor = "A";
            return;
        }
    }

    if (bLastSet) {
        const setAlreadyWon =
            state.pointsB >= 11 &&
            (state.pointsB - state.pointsA) >= 2;

        if (!setAlreadyWon &&
            state.pointsB >= 10 &&
            state.pointsB > state.pointsA
        ) {
            state.matchPointFor = "B";
        }
    }
}

/* =============================
   POINT MANAGEMENT
============================= */

function addPoint(team) {
    if (state.finished) return;

    if (team === "A") state.pointsA++;
    else state.pointsB++;

    state.pointHistory.push({
        t: Date.now(),
        type: team === "A" ? "POINT_A" : "POINT_B"
    });

    const total = state.pointsA + state.pointsB;
    const deuce =
        state.pointsA >= 10 && state.pointsB >= 10;

    if (deuce) {
        switchServer();
    } else {
        if (total % 2 === 0) switchServer();
    }

    checkSetWinner();
}

function checkSetWinner() {
    const diff = Math.abs(state.pointsA - state.pointsB);

    const setWon =
        (state.pointsA >= 11 || state.pointsB >= 11) &&
        diff >= 2;

    if (!setWon) {
        computeMatchPoint();
        return;
    }

    if (state.pointsA > state.pointsB) state.setsA++;
    else state.setsB++;

    state.pointHistory.push({
        t: Date.now(),
        type: "SET_END",
        score: { a: state.pointsA, b: state.pointsB }
    });

    // reset points
    state.pointsA = 0;
    state.pointsB = 0;
    state.timeoutActive = false;

    // REGLE OFFICIELLE :
    // on inverse le premier serveur du set précédent
    state.firstServerOfSet =
        state.firstServerOfSet === "A" ? "B" : "A";

    state.server = state.firstServerOfSet;

    checkMatchWinner();
}

/* =============================
   MATCH END
============================= */

function checkMatchWinner() {
    const target = neededSets();
    if (state.setsA === target || state.setsB === target) {
        state.finished = true;
        state.timeoutActive = false;
        state.matchPointFor = null;
        state.pointHistory.push({
            t: Date.now(),
            type: "MATCH_END"
        });
    }

    computeMatchPoint();
}

/* =============================
   RESET
============================= */

function resetMatchKeepSettings() {
    state.pointsA = 0;
    state.pointsB = 0;
    state.setsA = 0;
    state.setsB = 0;

    state.timeoutUsedA = false;
    state.timeoutUsedB = false;
    state.timeoutActive = false;

    state.matchPointFor = null;
    state.finished = false;

    state.firstServerOfSet = state.server;

    state.pointHistory.push({
        t: Date.now(),
        type: "RESET_MATCH"
    });
}

function resetAll() {
    state = createInitialState();
    undoStack = [];
}

/* =============================
   WEBSOCKET
============================= */

wss.on("connection", ws => {
    ws.send(JSON.stringify(state));

    ws.on("message", msg => {

        let data;
        try { data = JSON.parse(msg); }
        catch { return; }

        // UNDO
        if (data.type === "UNDO") {
            const last = undoStack.pop();
            if (last) state = last.s;
            computeMatchPoint();
            broadcast();
            return;
        }

        // RESET
        if (data.type === "RESET_ALL") {
            pushUndo("RESET_ALL");
            resetAll();
            broadcast();
            return;
        }

        if (data.type === "RESET_MATCH") {
            pushUndo("RESET_MATCH");
            resetMatchKeepSettings();
            computeMatchPoint();
            broadcast();
            return;
        }

        // SETTINGS
        if (data.type === "UPDATE_SETTINGS") {
            pushUndo("UPDATE_SETTINGS");

            // MODE
            if (data.mode === "singles" || data.mode === "doubles") {
                state.mode = data.mode;
            }

            // NOMS
            if (typeof data.A1 === "string")
                state.A1 = data.A1.trim() || state.A1;

            if (typeof data.A2 === "string")
                state.A2 = data.A2.trim();

            if (typeof data.B1 === "string")
                state.B1 = data.B1.trim() || state.B1;

            if (typeof data.B2 === "string")
                state.B2 = data.B2.trim();

            // BEST OF
            if (data.bestOf === 3 || data.bestOf === 5)
                state.bestOf = data.bestOf;

            // SERVEUR INITIAL
            if (data.server === "A" || data.server === "B") {
                state.server = data.server;
                state.firstServerOfSet = data.server;
            }

            computeMatchPoint();
            broadcast();
            return;
        }

        if (state.finished) return;

        // GAME ACTIONS
        if (
            ["POINT_A", "POINT_B",
                "TIMEOUT_A", "TIMEOUT_B",
                "END_TIMEOUT"].includes(data.type)
        ) pushUndo(data.type);

        switch (data.type) {

            case "POINT_A":
                addPoint("A");
                break;

            case "POINT_B":
                addPoint("B");
                break;

            case "TIMEOUT_A":
                if (!state.timeoutUsedA) {
                    state.timeoutUsedA = true;
                    state.timeoutActive = true;
                }
                break;

            case "TIMEOUT_B":
                if (!state.timeoutUsedB) {
                    state.timeoutUsedB = true;
                    state.timeoutActive = true;
                }
                break;

            case "END_TIMEOUT":
                state.timeoutActive = false;
                break;
        }

        computeMatchPoint();
        broadcast();
    });
});

console.log("🏓 Serveur TT Compétition lancé sur ws://localhost:8787");