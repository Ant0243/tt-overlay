const express = require("express")
const http = require("http")
const { Server } = require("socket.io")

const app = express()
const server = http.createServer(app)

const io = new Server(server,{
    cors:{origin:"*"}
})

app.use(express.static("public"))

const rooms = new Map()

/* ======================
STATE INITIAL
====================== */

function freshState(){

    return {

        players:{
            A:"JOUEUR A",
            B:"JOUEUR B"
        },

        points:{
            A:0,
            B:0
        },

        sets:{
            A:0,
            B:0
        },

        serve:"A",

        bestOf:5,

        sideSwap:false,

        timeoutActive:false,

        timeoutUsed:{
            A:false,
            B:false
        },

        history:[]

    }

}

/* ======================
ROOM
====================== */

function getRoom(room){

    if(!rooms.has(room)){
        rooms.set(room,freshState())
    }

    return rooms.get(room)

}

/* ======================
SAVE HISTORY
====================== */

function saveHistory(st){

    st.history.push(JSON.stringify(st))

    if(st.history.length > 30){
        st.history.shift()
    }

}

/* ======================
UNDO
====================== */

function undo(st){

    if(st.history.length === 0) return

    const prev = JSON.parse(st.history.pop())

    Object.assign(st,prev)

}

/* ======================
SERVICE LOGIC
====================== */

function updateServe(st){

    const total = st.points.A + st.points.B

    if(total < 20){

        if(total % 2 === 0){
            st.serve = st.serve === "A" ? "B" : "A"
        }

    }else{

        st.serve = st.serve === "A" ? "B" : "A"

    }

}

/* ======================
CHECK SET
====================== */

function checkSet(st){

    const A = st.points.A
    const B = st.points.B

    if(
        (A >= 11 || B >= 11) &&
        Math.abs(A-B) >= 2
    ){

        if(A > B){
            st.sets.A++
        }else{
            st.sets.B++
        }

        st.points.A = 0
        st.points.B = 0

    }

}

/* ======================
SOCKET
====================== */

io.on("connection",(socket)=>{

    socket.on("join",(room)=>{

        socket.join(room)

        const st = getRoom(room)

        socket.emit("state",st)

    })

    socket.on("action",(data)=>{

        const room = data.room || "table1"

        const st = getRoom(room)

        switch(data.type){

            case "POINT_A":

                saveHistory(st)

                st.points.A++

                updateServe(st)

                checkSet(st)

                break


            case "POINT_B":

                saveHistory(st)

                st.points.B++

                updateServe(st)

                checkSet(st)

                break


            case "SET_SERVE":

                st.serve = data.serve

                break


            case "SWAP_SIDES":

                st.sideSwap = !st.sideSwap

                break


            case "TIMEOUT_START":

                st.timeoutActive = true
                st.timeoutUsed[data.by] = true

                break


            case "TIMEOUT_END":

                st.timeoutActive = false

                break


            case "APPLY_SETTINGS":

                st.players = data.payload.players
                st.bestOf = data.payload.bestOf

                break


            case "UNDO":

                undo(st)

                break


            case "RESET_MATCH":

                rooms.set(room,freshState())

                break

        }

        io.to(room).emit("state",st)

    })

})

/* ======================
SERVER
====================== */

const PORT = process.env.PORT || 3000

server.listen(PORT,()=>{

    console.log("TT SERVER RUNNING")

})