const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
app.use(express.static("public"));

app.get("/", (req, res) => {
    res.redirect("/overlay.html");
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const port = process.env.PORT || 8787;
server.listen(port, () => {
    console.log("🏓 Serveur TT Compétition lancé sur port", port);
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

        server: null,
        firstServerOfSet: null,
        matchStarted: false,

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

/* ============================= */

function snapshot() {
    return JSON.parse(JSON.stringify(state));
}

function pushUndo() {
    undoStack.push(snapshot());
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
    if (!state.server) return;
    state.server = state.server === "A" ? "B" : "A";
}

/* =============================
   START MATCH
============================= */

function startMatch(firstServer) {
    if (state.matchStarted) return;

    if (firstServer === "A" || firstServer === "B") {
        state.matchStarted = true;
        state.server = firstServer;
        state.firstServerOfSet = firstServer;
    }
}

/* =============================
   POINT MANAGEMENT
============================= */

function addPoint(team) {
    if (!state.matchStarted) return;
    if (state.finished) return;

    if (team === "A") state.pointsA++;
    else state.pointsB++;

    state.pointHistory.push({
        type: "POINT",
        team
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

    if (!setWon) return;

    if (state.pointsA > state.pointsB) state.setsA++;
    else state.setsB++;

    state.pointHistory.push({
        type: "SET_END",
        score: { a: state.pointsA, b: state.pointsB }
    });

    state.pointsA = 0;
    state.pointsB = 0;
    state.timeoutActive = false;

    state.firstServerOfSet =
        state.firstServerOfSet === "A" ? "B" : "A";

    state.server = state.firstServerOfSet;

    checkMatchWinner();
}

function checkMatchWinner() {
    const target = neededSets();
    if (state.setsA === target || state.setsB === target) {
        state.finished = true;
        state.matchStarted = false;
        state.timeoutActive = false;

        state.pointHistory.push({
            type: "MATCH_END"
        });
    }
}

/* =============================
   RESET MATCH
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

    state.server = null;
    state.firstServerOfSet = null;
    state.matchStarted = false;

    state.pointHistory = [];
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

        if (data.type === "UNDO") {
            const last = undoStack.pop();
            if (last) state = last;
            broadcast();
            return;
        }

        if (data.type === "RESET_MATCH") {
            pushUndo();
            resetMatchKeepSettings();
            broadcast();
            return;
        }

        if (data.type === "RESET_ALL") {
            pushUndo();
            resetAll();
            broadcast();
            return;
        }

        if (data.type === "START_MATCH") {
            pushUndo();
            startMatch(data.firstServer);
            broadcast();
            return;
        }

        if (data.type === "UPDATE_SETTINGS") {

            if (typeof data.A1 === "string") state.A1 = data.A1.trim();
            if (typeof data.A2 === "string") state.A2 = data.A2.trim();
            if (typeof data.B1 === "string") state.B1 = data.B1.trim();
            if (typeof data.B2 === "string") state.B2 = data.B2.trim();

            if (data.mode === "singles" || data.mode === "doubles")
                state.mode = data.mode;

            if ((data.bestOf === 3 || data.bestOf === 5) && !state.matchStarted)
                state.bestOf = data.bestOf;

            broadcast();
            return;
        }

        if (
            ["POINT_A","POINT_B",
                "TIMEOUT_A","TIMEOUT_B",
                "END_TIMEOUT"].includes(data.type)
        ) pushUndo();

        switch (data.type) {

            case "POINT_A":
                addPoint("A");
                break;

            case "POINT_B":
                addPoint("B");
                break;

            case "TIMEOUT_A":
                if (!state.timeoutUsedA && state.matchStarted) {
                    state.timeoutUsedA = true;
                    state.timeoutActive = true;
                }
                break;

            case "TIMEOUT_B":
                if (!state.timeoutUsedB && state.matchStarted) {
                    state.timeoutUsedB = true;
                    state.timeoutActive = true;
                }
                break;

            case "END_TIMEOUT":
                state.timeoutActive = false;
                break;
        }

        broadcast();
    });
});