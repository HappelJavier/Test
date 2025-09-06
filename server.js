require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

// --- In-Memory Database ---
let questions = [
    { id: 1, text: "¿Cuál es la capital de Japón?", options: ["Tokio", "Osaka", "Kioto", "Nagoya"], correctOptions: [0] },
    { id: 2, text: "¿Qué lenguajes de programación son interpretados?", options: ["C++", "Python", "Java", "JavaScript"], correctOptions: [1, 3] },
];
let scores = {}; // { twitchUserId: score }
let currentGame = {
    question: null,
    answers: {},
    timeout: null
};

// --- API Endpoints for Streamer Panel ---

// Get all questions
app.get("/api/questions", (req, res) => {
    res.json(questions);
});

// Add a new question
app.post("/api/questions", (req, res) => {
    const { text, options, correctOptions } = req.body;
    if (!text || !options || !correctOptions) {
        return res.status(400).json({ error: "Missing required fields" });
    }
    const newQuestion = {
        id: questions.length + 1,
        text,
        options,
        correctOptions
    };
    questions.push(newQuestion);
    res.status(201).json(newQuestion);
});

// Start a new game round
app.post("/api/game/start", (req, res) => {
    const { questionId, timeLimit } = req.body;
    const question = questions.find(q => q.id === questionId);

    if (!question) {
        return res.status(404).json({ error: "Question not found" });
    }

    currentGame.question = question;
    currentGame.answers = {};

    // Prepare question data for clients (without correct answers)
    const questionForClients = {
        id: question.id,
        text: question.text,
        options: question.options,
        timeLimit
    };

    io.emit("start-question", questionForClients);
    console.log(`\n--- Question Started --- \nID: ${question.id}\nText: ${question.text}`);

    // Set a timeout to end the round
    currentGame.timeout = setTimeout(() => {
        endRound();
    }, timeLimit * 1000);

    res.status(200).json({ message: "Question started", question: questionForClients });
});

const endRound = () => {
    if (!currentGame.question) return;

    console.log(`--- Round Ended for Question ${currentGame.question.id} ---`);

    const roundResults = [];
    const maxPoints = 1000;
    const timePenaltyFactor = 50;

    for (const twitchUserId in currentGame.answers) {
        const answer = currentGame.answers[twitchUserId];
        const isCorrect = currentGame.question.correctOptions.includes(answer.selectedOption);

        let points = 0;
        const potentialPoints = Math.max(10, maxPoints - (answer.responseTime * timePenaltyFactor));

        if (isCorrect) {
            points = potentialPoints;
        } else {
            points = -Math.floor(potentialPoints / 2);
        }

        // Update global score
        if (!scores[twitchUserId]) scores[twitchUserId] = 0;
        scores[twitchUserId] += points;

        roundResults.push({ 
            twitchUserId,
            points,
            responseTime: answer.responseTime
        });
    }

    // Sort by points (desc) and then by response time (asc)
    roundResults.sort((a, b) => {
        if (b.points !== a.points) {
            return b.points - a.points;
        }
        return a.responseTime - b.responseTime;
    });

    const leaderboard = roundResults.slice(0, 5); // Top 5

    console.log("Leaderboard:", leaderboard);

    io.emit("round-end", { 
        leaderboard,
        correctOptions: currentGame.question.correctOptions
     });

    resetGame();
}

const resetGame = () => {
    if (currentGame.timeout) clearTimeout(currentGame.timeout);
    currentGame.question = null;
    currentGame.answers = {};
    currentGame.timeout = null;
};


// --- WebSocket (Socket.io) Setup ---
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", // Allow all origins for now
        methods: ["GET", "POST"]
    }
});

io.on("connection", (socket) => {
    console.log("\nA client connected:", socket.id);

    socket.on("submit-answer", (data) => {
        const { questionId, selectedOption, responseTime, twitchUserId } = data;

        // Validations
        if (!currentGame.question || currentGame.question.id !== questionId) {
            return; // Not the current question
        }
        if (currentGame.answers[twitchUserId]) {
            return; // User already answered
        }

        currentGame.answers[twitchUserId] = { selectedOption, responseTime };
        console.log(`Answer received from ${twitchUserId}: Option ${selectedOption} in ${responseTime}s`);
    });

    socket.on("disconnect", () => {
        console.log("Client disconnected:", socket.id);
    });
});



// --- Server Initialization ---
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`✅ Backend running on port ${PORT}`));

module.exports = { app, server };
