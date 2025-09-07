require('dotenv').config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const fs = require('fs').promises; // To read the schema file
const db = require('./db'); // Import the database module

const app = express();
app.use(cors());
app.use(express.json());

// --- In-Memory State for Live Game ---
// The actual questions and quizzes are now in the DB.
// This object only holds the state of a currently active quiz session.


// Activate a quiz, making it the currently active one.
let currentQuizSession = {
    quizId: null,
    quizInstanceId: null, // New: ID of the current quiz instance
    questionIndex: 0,
    userScores: {},
    currentQuestion: null,
    timeout: null,
};

// --- API Endpoints ---

// Endpoint to initialize the database by running the schema.sql file
app.post("/api/db/init", async (req, res) => {
    try {
        const schema = await fs.readFile('./schema.sql', 'utf8');
        await db.query(schema);
        res.status(200).json({ message: "Database initialized successfully!" });
    } catch (err) {
        console.error("Error initializing database:", err);
        res.status(500).json({ error: "Failed to initialize database." });
    }
});

// Get all questions from the database
app.get("/api/questions", async (req, res) => {
    try {
        const { rows } = await db.query('SELECT * FROM questions ORDER BY created_at DESC');
        res.json(rows);
    } catch (err) {
        console.error("Error fetching questions:", err);
        res.status(500).json({ error: "Failed to fetch questions." });
    }
});

// Add a new question to the database
app.post("/api/questions", async (req, res) => {
    // Note: The schema now expects a single correct_option index
    const { text, options, correctOption } = req.body;
    if (!text || !options || options.length !== 4 || correctOption === undefined) {
        return res.status(400).json({ error: "Missing or invalid required fields" });
    }

    const query = 'INSERT INTO questions(text, options, correct_option) VALUES($1, $2, $3) RETURNING *';
    const values = [text, options, correctOption];

    try {
        const { rows } = await db.query(query, values);
        res.status(201).json(rows[0]);
    } catch (err) {
        console.error("Error creating question:", err);
        res.status(500).json({ error: "Failed to create question." });
    }
});

// Update an existing question
app.put("/api/questions/:id", async (req, res) => {
    const { id } = req.params;
    const { text, options, correctOption } = req.body;

    if (!text || !options || options.length !== 4 || correctOption === undefined) {
        return res.status(400).json({ error: "Missing or invalid required fields" });
    }

    const query = 'UPDATE questions SET text = $1, options = $2, correct_option = $3 WHERE id = $4 RETURNING *';
    const values = [text, options, correctOption, id];

    try {
        const { rows } = await db.query(query, values);
        if (rows.length === 0) {
            return res.status(404).json({ error: "Question not found." });
        }
        res.status(200).json(rows[0]);
    } catch (err) {
        console.error(`Error updating question ${id}:`, err);
        res.status(500).json({ error: "Failed to update question." });
    }
});

// Delete a question
app.delete("/api/questions/:id", async (req, res) => {
    const { id } = req.params;

    try {
        const { rowCount } = await db.query('DELETE FROM questions WHERE id = $1', [id]);
        if (rowCount === 0) {
            return res.status(404).json({ error: "Question not found." });
        }
        res.status(200).json({ message: "Question deleted successfully." });
    } catch (err) {
        console.error(`Error deleting question ${id}:`, err);
        res.status(500).json({ error: "Failed to delete question." });
    }
});

// Get status of the current active quiz
app.get("/api/quiz/status", async (req, res) => {
    if (!currentQuizSession.quizId) {
        return res.status(200).json({ active: false, message: "No quiz currently active." });
    }

    try {
        // Fetch the ordered list of questions for the active quiz
        const quizQuestionsQuery = `
            SELECT q.id as question_id, q.text, q.options, q.correct_option, qq.time_limit
            FROM quiz_questions qq
            JOIN questions q ON qq.question_id = q.id
            WHERE qq.quiz_id = $1
            ORDER BY qq.display_order ASC;
        `;
        const { rows: questionsInQuiz } = await db.query(quizQuestionsQuery, [currentQuizSession.quizId]);

        let lastQuestionResults = [];
        let lastQuestion = null;

        // Determine the last completed question
        if (currentQuizSession.questionIndex > 0) {
            lastQuestion = questionsInQuiz[currentQuizSession.questionIndex - 1];
            if (lastQuestion) {
                const responsesQuery = `
                    SELECT u.twitch_user_id, r.score, r.response_time_ms, r.is_correct, r.selected_option
                    FROM responses r
                    JOIN users u ON r.user_id = u.id
                    WHERE r.quiz_instance_id = $1 AND r.question_id = $2
                    ORDER BY r.score DESC;
                `;
                const { rows: responses } = await db.query(responsesQuery, [currentQuizSession.quizInstanceId, lastQuestion.question_id]);
                lastQuestionResults = responses;
            }
        }

        res.status(200).json({
            active: true,
            quizId: currentQuizSession.quizId,
            quizInstanceId: currentQuizSession.quizInstanceId, // Include instance ID
            questionIndex: currentQuizSession.questionIndex,
            userScores: currentQuizSession.userScores, // Total scores for the quiz
            lastQuestion: lastQuestion ? { id: lastQuestion.question_id, text: lastQuestion.text, correct_option: lastQuestion.correct_option } : null,
            lastQuestionResults: lastQuestionResults, // Results for the last completed question
            totalQuestions: questionsInQuiz.length,
        });

    } catch (err) {
        console.error("Error fetching quiz status:", err);
        res.status(500).json({ error: "Failed to fetch quiz status." });
    }
});

// Get all quizzes from the database
app.get("/api/quizzes", async (req, res) => {
    try {
        // This query joins quizzes with their questions to also return the question count
        const query = `
            SELECT 
                q.*, 
                COUNT(qq.id) as question_count
            FROM quizzes q
            LEFT JOIN quiz_questions qq ON q.id = qq.quiz_id
            GROUP BY q.id
            ORDER BY q.created_at DESC;
        `;
        const { rows } = await db.query(query);
        res.json(rows);
    } catch (err) {
        console.error("Error fetching quizzes:", err);
        res.status(500).json({ error: "Failed to fetch quizzes." });
    }
});

// Create a new quiz
app.post("/api/quizzes", async (req, res) => {
    const { name, questions } = req.body; // questions is an array of { question_id, time_limit, display_order }
    if (!name || !questions || !Array.isArray(questions) || questions.length === 0) {
        return res.status(400).json({ error: "Missing or invalid required fields" });
    }

    try {
        // Start a transaction
        await db.query('BEGIN');

        // Insert the quiz
        const quizQuery = 'INSERT INTO quizzes(name, last_activated_at) VALUES($1, NULL) RETURNING id';
        const quizResult = await db.query(quizQuery, [name]);
        const newQuizId = quizResult.rows[0].id;

        // Insert the associated questions
        for (const q of questions) {
            const quizQuestionsQuery = 'INSERT INTO quiz_questions(quiz_id, question_id, time_limit, display_order) VALUES($1, $2, $3, $4)';
            await db.query(quizQuestionsQuery, [newQuizId, q.question_id, q.time_limit, q.display_order]);
        }

        // Commit the transaction
        await db.query('COMMIT');

        res.status(201).json({ id: newQuizId, name, questions });

    } catch (err) {
        // If any error, rollback the transaction
        await db.query('ROLLBACK');
        console.error("Error creating quiz:", err);
        res.status(500).json({ error: "Failed to create quiz." });
    }
});



// ...

// Activate a quiz, making it the currently active one.
app.post("/api/quiz/activate", async (req, res) => {
    const { quizId } = req.body;
    if (!quizId) {
        return res.status(400).json({ error: "quizId is required" });
    }
    if (currentQuizSession.quizId) {
        return res.status(409).json({ error: `Quiz ${currentQuizSession.quizId} is already active.` });
    }

    try {
        // Start a transaction for quiz activation and instance creation
        await db.query('BEGIN');

        // Verify quiz exists and update its last_activated_at timestamp
        const updateQuizQuery = 'UPDATE quizzes SET last_activated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING id';
        const { rows: quizRows } = await db.query(updateQuizQuery, [quizId]);

        if (quizRows.length === 0) {
            await db.query('ROLLBACK');
            return res.status(404).json({ error: "Quiz not found." });
        }

        // Create a new quiz instance
        const createInstanceQuery = 'INSERT INTO quiz_instances(quiz_id) VALUES($1) RETURNING id';
        const { rows: instanceRows } = await db.query(createInstanceQuery, [quizId]);
        const newQuizInstanceId = instanceRows[0].id;

        // Set the server's in-memory state for the live game
        currentQuizSession = {
            quizId: quizId,
            quizInstanceId: newQuizInstanceId, // Store the new instance ID
            questionIndex: 0,
            userScores: {},
            currentQuestion: null,
            timeout: null,
        };

        await db.query('COMMIT');

        io.emit("quiz-ready", { quizId });
        console.log(`--- Quiz ${quizId} activated (Instance: ${newQuizInstanceId}) ---`);
        res.status(200).json({ message: `Quiz ${quizId} activated. Ready to start first question.` });

    } catch (err) {
        await db.query('ROLLBACK');
        console.error("Error activating quiz:", err);
        res.status(500).json({ error: "Failed to activate quiz." });
    }
});

// Manually trigger the next question in the active quiz
app.post("/api/quiz/next-question", async (req, res) => {
    if (!currentQuizSession.quizId) {
        return res.status(400).json({ error: "No quiz is currently active." });
    }

    try {
        // Fetch the ordered list of questions for the active quiz
        const quizQuestionsQuery = `
            SELECT q.*, qq.time_limit
            FROM quiz_questions qq
            JOIN questions q ON qq.question_id = q.id
            WHERE qq.quiz_id = $1
            ORDER BY qq.display_order ASC;
        `;
        const { rows: questionsInQuiz } = await db.query(quizQuestionsQuery, [currentQuizSession.quizId]);

        if (currentQuizSession.questionIndex >= questionsInQuiz.length) {
            // Quiz is over
            io.emit("quiz-end", { finalScores: currentQuizSession.userScores });
            console.log(`--- Quiz ${currentQuizSession.quizId} ended ---`);

            // Update end_time for the quiz instance
            if (currentQuizSession.quizInstanceId) {
                await db.query('UPDATE quiz_instances SET end_time = CURRENT_TIMESTAMP WHERE id = $1', [currentQuizSession.quizInstanceId]);
            }

            currentQuizSession = { quizId: null, questionIndex: 0, userScores: {}, currentQuestion: null, timeout: null }; // Reset state
            return res.status(200).json({ message: "Quiz finished." });
        }

        const nextQuestion = questionsInQuiz[currentQuizSession.questionIndex];
        currentQuizSession.currentQuestion = nextQuestion; // Store full question data for scoring
        currentQuizSession.currentQuestion.answers = {}; // Reset answers for the new round

        // Prepare a clean version of the question for clients (without correct_option)
        const questionForClients = {
            id: nextQuestion.id,
            text: nextQuestion.text,
            options: nextQuestion.options,
            timeLimit: nextQuestion.time_limit
        };

        io.emit("start-question", questionForClients);
        console.log(`--- Question ${nextQuestion.id} started for Quiz ${currentQuizSession.quizId} ---`);

        // Increment index for the next call
        currentQuizSession.questionIndex++;

        // Set timeout for the round to end
        if (currentQuizSession.timeout) clearTimeout(currentQuizSession.timeout);
        currentQuizSession.timeout = setTimeout(() => {
            endRound();
        }, nextQuestion.time_limit * 1000);

        res.status(200).json({ message: `Question ${nextQuestion.id} started.` });

    } catch (err) {
        console.error("Error starting next question:", err);
        res.status(500).json({ error: "Failed to start next question." });
    }
});

const endRound = async () => {
    if (!currentQuizSession.quizId || !currentQuizSession.currentQuestion) {
        return; // No active round to end
    }

    console.log(`--- Round Ended for Question ${currentQuizSession.currentQuestion.id} ---`);

    const roundResults = [];
    const maxPoints = 1000;
    const timePenaltyFactor = 50;

    const answers = currentQuizSession.currentQuestion.answers || {};

    for (const userId in answers) {
        const answer = answers[userId];
        const isCorrect = currentQuizSession.currentQuestion.correct_option === answer.selectedOption;

        let points = 0;
        const potentialPoints = Math.max(10, maxPoints - (answer.responseTime * timePenaltyFactor));

        if (isCorrect) {
            points = potentialPoints;
        } else {
            points = -Math.floor(potentialPoints / 2);
        }

        // Update total score for the session in memory
        if (!currentQuizSession.userScores[userId]) currentQuizSession.userScores[userId] = 0;
        currentQuizSession.userScores[userId] += points;

        // Save the detailed response to the database
        const responseQuery = `
            INSERT INTO responses(quiz_instance_id, quiz_id, question_id, user_id, selected_option, response_time_ms, score, is_correct)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8);
        `;
        await db.query(responseQuery, [
            currentQuizSession.quizInstanceId, // Use quiz instance ID
            currentQuizSession.quizId,
            currentQuizSession.currentQuestion.id,
            userId, // This is the internal DB id, not the twitch_user_id
            answer.selectedOption,
            Math.floor(Number(answer.responseTime) * 1000),
            points,
            isCorrect
        ]);

        roundResults.push({
            twitchUserId: answer.twitchUserId, // Send twitchId to front
            points
        });
    }

    roundResults.sort((a, b) => b.points - a.points);
    const leaderboard = roundResults.slice(0, 5);

    io.emit("round-end", {
        leaderboard,
        correctOption: currentQuizSession.currentQuestion.correct_option
    });

    // Clear question-specific data for the next round
    currentQuizSession.currentQuestion = null;
    if (currentQuizSession.timeout) clearTimeout(currentQuizSession.timeout);
};

// --- WebSocket (Socket.io) Setup ---
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const findOrCreateUser = async (twitchUserId) => {
    // First, try to find the user
    let user = await db.query('SELECT id FROM users WHERE twitch_user_id = $1', [twitchUserId]);
    if (user.rows.length > 0) {
        return user.rows[0]; // User found, return it
    }
    // If not found, create a new user
    user = await db.query('INSERT INTO users(twitch_user_id) VALUES($1) RETURNING id', [twitchUserId]);
    console.log(`New user created with Twitch ID: ${twitchUserId}`);
    return user.rows[0]; // Return the newly created user
};

io.on("connection", (socket) => {
    console.log(`\nA client connected: ${socket.id}`);

    socket.on('submit-answer', async (data) => {
        const { questionId, selectedOption, responseTime, twitchUserId } = data;

        // --- Validations ---
        if (!currentQuizSession.currentQuestion || currentQuizSession.currentQuestion.id !== questionId) {
            return; // Answer is not for the current question, ignore.
        }

        const user = await findOrCreateUser(twitchUserId);
        if (!user) return; // Should not happen

        // Check if user has already answered this question in memory
        if (currentQuizSession.currentQuestion.answers[user.id]) {
            return; // User already answered, ignore.
        }

        // Store answer in memory for quick processing at the end of the round
        currentQuizSession.currentQuestion.answers[user.id] = {
            selectedOption,
            responseTime,
            twitchUserId // Keep this for the leaderboard response
        };
        console.log(`Answer received from user ${user.id} (Twitch: ${twitchUserId})`);
    });

    socket.on("disconnect", () => {
        console.log(`Client disconnected: ${socket.id}`);
    });
});


// --- Server Initialization ---
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`✅ Backend running on port ${PORT}`));

module.exports = { app, server };