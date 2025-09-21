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

// --- User Session Management ---
const socketUserMap = new Map(); // Maps socket.id -> { dbUserId, isAnonymous, anonymousNumber }
const usedAnonymousNumbers = new Set();
let nextAnonymousNumber = 1;

// --- Twitch API Helpers ---

let twitchAppToken = {
    access_token: null,
    expires_at: null,
};

// Fetches and caches a Twitch App Access Token
async function getAppAccessToken() {
    const now = Date.now();
    if (twitchAppToken.access_token && twitchAppToken.expires_at > now) {
        return twitchAppToken.access_token;
    }

    const clientId = process.env.TWITCH_CLIENT_ID;
    const clientSecret = process.env.TWITCH_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
        console.error("Twitch Client ID or Client Secret is not configured in environment variables.");
        return null;
    }

    try {
        const response = await fetch('https://id.twitch.tv/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `client_id=${clientId}&client_secret=${clientSecret}&grant_type=client_credentials`,
        });

        if (!response.ok) {
            throw new Error(`Failed to get Twitch token: ${response.statusText}`);
        }

        const data = await response.json();
        const expiresInMs = (data.expires_in - 60) * 1000; // Subtract 60s for safety margin

        twitchAppToken = {
            access_token: data.access_token,
            expires_at: now + expiresInMs,
        };

        console.log("Successfully fetched new Twitch App Access Token.");
        return twitchAppToken.access_token;

    } catch (error) {
        console.error("Error fetching Twitch App Access Token:", error);
        return null;
    }
}

// Fetches a user's display name from their Twitch ID
async function getTwitchDisplayName(twitchUserId) {
    // Remove 'U' prefix if present
    let cleanedTwitchUserId = twitchUserId;
    if (typeof twitchUserId === 'string' && twitchUserId.startsWith('U')) {
        cleanedTwitchUserId = twitchUserId.substring(1);
        console.log(`getTwitchDisplayName: Removed 'U' prefix. Original: ${twitchUserId}, Cleaned: ${cleanedTwitchUserId}`);
    }

    const token = await getAppAccessToken();
    const clientId = process.env.TWITCH_CLIENT_ID;

    if (!token || !clientId) {
        console.error(`getTwitchDisplayName: Missing token or clientId. Token: ${token ? 'present' : 'missing'}, ClientID: ${clientId ? 'present' : 'missing'}`);
        return `User_${cleanedTwitchUserId}`; // Fallback with cleaned ID
    }

    try {
        console.log(`getTwitchDisplayName: Fetching display name for ${cleanedTwitchUserId} with Client-ID: ${clientId}, Token: ${token.substring(0, 10)}...`); // Log token partially
        const response = await fetch(`https://api.twitch.tv/helix/users?id=${cleanedTwitchUserId}`, { // Use cleaned ID
            headers: {
                'Client-ID': clientId,
                'Authorization': `Bearer ${token}`,
            },
        });

        if (!response.ok) {
            const errorBody = await response.text(); // Read error response body
            console.error(`getTwitchDisplayName: Twitch API request failed for ${twitchUserId}. Status: ${response.status}, StatusText: ${response.statusText}, Body: ${errorBody}`);
            throw new Error(`Twitch API request failed: ${response.statusText}`);
        }

        const data = await response.json();
        if (data.data && data.data.length > 0) {
            console.log(`getTwitchDisplayName: Successfully fetched display name for ${twitchUserId}: ${data.data[0].display_name}`);
            return data.data[0].display_name;
        }
        console.warn(`getTwitchDisplayName: User ${twitchUserId} not found in Twitch API response.`);
        return `User_${twitchUserId}`; // Fallback if user not found

    } catch (error) {
        console.error(`getTwitchDisplayName: Error in catch block for ${twitchUserId}:`, error);
        return `User_${twitchUserId}`; // Fallback on error
    }
}

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

// Delete a quiz
app.delete("/api/quiz/:id", async (req, res) => {
    const { id } = req.params;

    try {
        const { rowCount } = await db.query('DELETE FROM quizzes WHERE id = $1', [id]);
        if (rowCount === 0) {
            return res.status(404).json({ error: "Quiz not found." });
        }
        res.status(200).json({ message: "Quiz deleted successfully." });
    } catch (err) {
        console.error(`Error deleting quiz ${id}:`, err);
        res.status(500).json({ error: "Failed to delete quiz." });
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
    const { quizId, name } = req.body;
    if (!quizId) {
        return res.status(400).json({ error: "quizId is required" });
    }
    // If a quiz is already active, reset it first to ensure a clean slate
    if (currentQuizSession.quizId) {
        console.log(`Resetting previous quiz ${currentQuizSession.quizId} before activating new one.`);
        resetQuizSession();
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

        io.emit("quiz-ready", { quizId: quizId, name: name });
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
            // Quiz is over, time to show final results.
            console.log(`--- Quiz ${currentQuizSession.quizId} is over, showing final results. ---`);
            io.emit("show-final-results", { finalScores: currentQuizSession.userScores });

            // Reset the session immediately after showing final results
            // This prepares the backend for a new quiz activation


            return res.status(200).json({ message: "Quiz finished. Displaying final results." });
        }

        const nextQuestion = questionsInQuiz[currentQuizSession.questionIndex];
        currentQuizSession.currentQuestion = nextQuestion; // Store full question data for scoring
        currentQuizSession.currentQuestion.answers = {}; // Reset answers for the new round
        currentQuizSession.currentQuestion.receivedAnswerCount = 0; // Initialize received answer count
        currentQuizSession.currentQuestion.expectedAnswerCount = activeParticipantSocketIds.size; // Set expected answers

        // Prepare a clean version of the question for clients (without correct_option)
        const questionForClients = {
            quizId: currentQuizSession.quizId,
            id: nextQuestion.id,
            text: nextQuestion.text,
            options: nextQuestion.options,
            timeLimit: nextQuestion.time_limit
        };

        io.emit("start-question", questionForClients);

        // Send a special event to the control panel with the correct answer
        if (controlPanelSocketId) {
            const questionForControlPanel = {
                ...questionForClients,
                correctOption: nextQuestion.correct_option, // Add the correct option
            };
            io.to(controlPanelSocketId).emit("start-question-control-panel", questionForControlPanel);
        }

        console.log(`--- Question ${nextQuestion.id} started for Quiz ${currentQuizSession.quizId} ---`);
        console.log(`Expecting ${currentQuizSession.currentQuestion.expectedAnswerCount} answers.`);

        // Increment index for the next call
        currentQuizSession.questionIndex++;

        // Set a submission window timeout for the round to end unconditionally
        const GRACE_PERIOD_SECONDS = 5; // Additional time to wait for answers after timeLimit
        const submissionWindow = (nextQuestion.time_limit + GRACE_PERIOD_SECONDS) * 1000;

        if (currentQuizSession.submissionWindowTimeout) clearTimeout(currentQuizSession.submissionWindowTimeout);
        currentQuizSession.submissionWindowTimeout = setTimeout(() => {
            console.log("Submission window closed. Ending round.");
            endRound();
        }, submissionWindow);

        res.status(200).json({ message: `Question ${nextQuestion.id} started.` });

    } catch (err) {
        console.error("Error starting next question:", err);
        res.status(500).json({ error: "Failed to start next question." });
    }
});

function resetQuizSession() {
    if (currentQuizSession.submissionWindowTimeout) { // Clear the new timeout
        clearTimeout(currentQuizSession.submissionWindowTimeout);
    }
    currentQuizSession = {
        quizId: null,
        quizInstanceId: null,
        questionIndex: 0,
        userScores: {},
        currentQuestion: null,
        submissionWindowTimeout: null, // Ensure this is reset
    };
    console.log("Quiz session state has been reset.");
}

app.post("/api/quiz/deactivate", async (req, res) => {
    if (!currentQuizSession.quizId) {
        resetQuizSession();
        return res.status(400).json({ error: "No quiz is currently active." });
    }

    try {
        const quizId = currentQuizSession.quizId;
        console.log(`--- Manually ending quiz ${quizId} ---`);

        // Update end_time for the quiz instance in the database
        if (currentQuizSession.quizInstanceId) {
            await db.query('UPDATE quiz_instances SET end_time = CURRENT_TIMESTAMP WHERE id = $1', [currentQuizSession.quizInstanceId]);
        }

        // Emit a quiz-end event to all clients
        io.emit("quiz-end", { finalScores: currentQuizSession.userScores, manualStop: true });

        // Reset the in-memory state
        resetQuizSession();

        res.status(200).json({ message: `Quiz ${quizId} deactivated successfully.` });

    } catch (err) {
        console.error("Error deactivating quiz:", err);
        res.status(500).json({ error: "Failed to deactivate quiz." });
    }
});

const calculateRoundResults = (answers, correctOption, timeLimit) => {
    const roundResults = [];

    for (const userId in answers) {
        const answer = answers[userId];
        const isCorrect = correctOption === answer.selectedOption;

        let points = 0;

        if (answer.selectedOption === -1) { // No answer submitted
            points = 0;
        } else if (isCorrect) {
            // responseTime is now the points (remaining time in ms)
            points = answer.responseTime;
        } else {
            // Incorrect answer, points are negative
            points = -answer.responseTime;
        }

        roundResults.push({
            userId: userId, // Keep internal ID for processing
            twitchUserId: answer.twitchUserId,
            displayName: answer.displayName,
            points: Math.floor(points) // Ensure points are integer
        });
    }

    return roundResults.sort((a, b) => b.points - a.points);
};

const endRound = async () => {
    if (!currentQuizSession.quizId || !currentQuizSession.currentQuestion) return;

    console.log(`--- Round Ended for Question ${currentQuizSession.currentQuestion.id} ---`);

    const answers = currentQuizSession.currentQuestion.answers || {};
    const finalRoundResults = calculateRoundResults(
        answers,
        currentQuizSession.currentQuestion.correct_option,
        currentQuizSession.currentQuestion.time_limit // Pass time_limit
    );

    // Count votes for each option
    const optionVoteCounts = { 0: 0, 1: 0, 2: 0, 3: 0, '-1': 0 }; // Initialize counts for options and no answer
    for (const userId in answers) {
        const selectedOption = answers[userId].selectedOption;
        if (optionVoteCounts.hasOwnProperty(selectedOption)) {
            optionVoteCounts[selectedOption]++;
        } else {
            // Handle unexpected selectedOption values, though -1 should cover no answer
            console.warn(`Unexpected selectedOption value: ${selectedOption}`);
        }
    }

    // Use a transaction to ensure all or nothing
    const client = await db.getClient();
    try {
        await client.query('BEGIN');

        for (const result of finalRoundResults) {
            const answer = answers[result.userId];
            if (!answer) continue;

            // Update total score in memory
            if (!currentQuizSession.userScores[result.userId]) {
                currentQuizSession.userScores[result.userId] = {
                    score: 0,
                    twitchUserId: result.twitchUserId,
                    displayName: result.displayName
                };
            }
            currentQuizSession.userScores[result.userId].score += result.points;

            // Save response to DB
            const responseQuery = `
                INSERT INTO responses(quiz_instance_id, quiz_id, question_id, user_id, selected_option, response_time_ms, score, is_correct)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8);
            `;
            await client.query(responseQuery, [
                currentQuizSession.quizInstanceId,
                currentQuizSession.quizId,
                currentQuizSession.currentQuestion.id,
                result.userId,
                answer.selectedOption,
                Math.floor(Number(answer.responseTime) * 1000),
                result.points,
                result.points > 0
            ]);
        }

        await client.query('COMMIT');

    } catch (e) {
        await client.query('ROLLBACK');
        console.error('Error during end-of-round transaction:', e);
    } finally {
        client.release();
    }

    // Emit final round results and updated overall scores
    io.emit("round-end", {
        roundResults: finalRoundResults,
        userScores: currentQuizSession.userScores,
        correctOption: currentQuizSession.currentQuestion.correct_option,
        optionVoteCounts: optionVoteCounts // Add vote counts
    });

    currentQuizSession.currentQuestion = null;
    if (currentQuizSession.submissionWindowTimeout) clearTimeout(currentQuizSession.submissionWindowTimeout);
    currentQuizSession.submissionWindowTimeout = null; // Clear the timeout reference
};

// --- WebSocket (Socket.io) Setup ---
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

let controlPanelSocketId = null; // To store the socket ID of the control panel
const activeParticipantSocketIds = new Set(); // To store socket IDs of active players

async function initializeAnonymousUserTracking() {
    console.log("Initializing anonymous user tracking...");
    try {
        const { rows } = await db.query("SELECT display_name FROM users WHERE twitch_user_id LIKE 'U%' AND display_name LIKE 'User %'");
        for (const row of rows) {
            const match = row.display_name.match(/^User (\d+)$/);
            if (match && match[1]) {
                const num = parseInt(match[1], 10);
                usedAnonymousNumbers.add(num);
            }
        }
        while (usedAnonymousNumbers.has(nextAnonymousNumber)) {
            nextAnonymousNumber++;
        }
        console.log("Anonymous user tracking initialized. Used numbers:", Array.from(usedAnonymousNumbers));
        console.log("Next available anonymous number:", nextAnonymousNumber);
    } catch (error) {
        console.error("Error initializing anonymous user tracking:", error);
    }
}

async function findNextAvailableAnonymousNumber() {
    while (usedAnonymousNumbers.has(nextAnonymousNumber)) {
        nextAnonymousNumber++;
    }
    return nextAnonymousNumber;
}

async function createAnonymousUser(twitchUserId) {
    // Verificar si ya existe
    const existing = await db.query('SELECT id, display_name FROM users WHERE twitch_user_id = $1', [twitchUserId]);
    if (existing.rows.length > 0) {
        // Ya existe, devolver el usuario existente
        return {
            dbUserId: existing.rows[0].id,
            displayName: existing.rows[0].display_name,
            anonymousNumber: parseInt(existing.rows[0].display_name.replace('User ', ''), 10) || null,
        };
    }

    const anonymousNumber = await findNextAvailableAnonymousNumber();
    const displayName = `User ${anonymousNumber}`;

    const { rows } = await db.query(
        'INSERT INTO users(twitch_user_id, display_name) VALUES($1, $2) RETURNING id, display_name',
        [twitchUserId, displayName]
    );
    const newUser = rows[0];

    usedAnonymousNumbers.add(anonymousNumber);
    console.log(`Created anonymous user: ${displayName} (Twitch ID: ${twitchUserId})`);

    return {
        dbUserId: newUser.id,
        displayName: newUser.display_name,
        anonymousNumber: anonymousNumber,
    };
}

async function mergeUsers(anonymousDbUserId, authenticatedDbUserId) {
    console.log(`Merging user ID ${anonymousDbUserId} into ${authenticatedDbUserId}`);
    const client = await db.getClient();
    try {
        await client.query('BEGIN');
        await client.query('UPDATE responses SET user_id = $1 WHERE user_id = $2', [authenticatedDbUserId, anonymousDbUserId]);
        await client.query('DELETE FROM users WHERE id = $1', [anonymousDbUserId]);
        await client.query('COMMIT');
        console.log(`Successfully merged user data in DB.`);
    } catch (e) {
        await client.query('ROLLBACK');
        console.error(`Error merging users in DB:`, e);
    } finally {
        client.release();
    }
}

async function mergeInMemoryData(anonymousDbUserId, authenticatedDbUserId) {
    console.log(`Merging in-memory data for user ID ${anonymousDbUserId} into ${authenticatedDbUserId}`);
    // Obtener el displayName actualizado del usuario autenticado
    let newDisplayName = null;
    try {
        const res = await db.query('SELECT display_name FROM users WHERE id = $1', [authenticatedDbUserId]);
        if (res.rows.length > 0) newDisplayName = res.rows[0].display_name;
    } catch (e) {
        console.error('Error fetching displayName for merge:', e);
    }

    if (currentQuizSession.userScores[anonymousDbUserId]) {
        const anonymousScore = currentQuizSession.userScores[anonymousDbUserId].score || 0;
        if (!currentQuizSession.userScores[authenticatedDbUserId]) {
            const anonymousUserData = currentQuizSession.userScores[anonymousDbUserId];
            currentQuizSession.userScores[authenticatedDbUserId] = {
                ...anonymousUserData,
                score: 0,
                displayName: newDisplayName || anonymousUserData.displayName
            };
        }
        currentQuizSession.userScores[authenticatedDbUserId].score += anonymousScore;
        // Actualizar el displayName si ya existía
        if (newDisplayName) {
            currentQuizSession.userScores[authenticatedDbUserId].displayName = newDisplayName;
        }
        delete currentQuizSession.userScores[anonymousDbUserId];
    }

    if (currentQuizSession.currentQuestion && currentQuizSession.currentQuestion.answers[anonymousDbUserId]) {
        const answerData = currentQuizSession.currentQuestion.answers[anonymousDbUserId];
        currentQuizSession.currentQuestion.answers[authenticatedDbUserId] = {
            ...answerData,
            displayName: newDisplayName || answerData.displayName
        };
        delete currentQuizSession.currentQuestion.answers[anonymousDbUserId];
    }
}

const findOrCreateUser = async (twitchUserId, displayName) => {
    // This function now primarily deals with authenticated users.
    let userResult = await db.query('SELECT id FROM users WHERE twitch_user_id = $1', [twitchUserId]);

    if (userResult.rows.length > 0) {
        const user = userResult.rows[0];
        await db.query('UPDATE users SET display_name = $1 WHERE id = $2', [displayName, user.id]);
        return user;
    } else {
        const newUserResult = await db.query(
            'INSERT INTO users(twitch_user_id, display_name) VALUES($1, $2) RETURNING id',
            [twitchUserId, displayName]
        );
        return newUserResult.rows[0];
    }
};

io.on("connection", (socket) => {
    console.log(`\nA client connected: ${socket.id}`);

    // Add to active participants if not control panel
    if (socket.id !== controlPanelSocketId) { // Initial check, will be updated by register-control-panel
        activeParticipantSocketIds.add(socket.id);
        console.log(`Participant connected: ${socket.id}. Total participants: ${activeParticipantSocketIds.size}`);
    }

    socket.on('register-control-panel', () => {
        // Remove from active participants if it was initially added as one
        if (activeParticipantSocketIds.has(socket.id)) {
            activeParticipantSocketIds.delete(socket.id);
            console.log(`Control Panel ${socket.id} removed from participants. Total participants: ${activeParticipantSocketIds.size}`);
        }
        controlPanelSocketId = socket.id;
        console.log(`Control Panel registered with ID: ${controlPanelSocketId}`);
    });


    // --- Merge user event: opaqueId -> realUserId ---
    socket.on('merge-user', async ({ opaqueId, realUserId }) => {
        try {
            if (!opaqueId || !realUserId) return;
            // Buscar o crear usuario anónimo
            let anonUserRes = await db.query('SELECT id FROM users WHERE twitch_user_id = $1', [opaqueId]);
            if (anonUserRes.rows.length === 0) {
                const anon = await createAnonymousUser(opaqueId);
                anonUserRes = { rows: [{ id: anon.dbUserId }] };
            }
            // Buscar o crear usuario autenticado
            let realUserRes = await db.query('SELECT id FROM users WHERE twitch_user_id = $1', [realUserId]);
            if (realUserRes.rows.length === 0) {
                const displayName = await getTwitchDisplayName(realUserId);
                const newUser = await db.query(
                    'INSERT INTO users(twitch_user_id, display_name) VALUES($1, $2) RETURNING id',
                    [realUserId, displayName]
                );
                realUserRes = { rows: [{ id: newUser.rows[0].id }] };
            }
            const anonDbUserId = anonUserRes.rows[0].id;
            const realDbUserId = realUserRes.rows[0].id;
            if (anonDbUserId === realDbUserId) {
                console.log('merge-user: Los IDs ya son iguales, nada que fusionar.');
                return;
            }
            await mergeUsers(anonDbUserId, realDbUserId);
            mergeInMemoryData(anonDbUserId, realDbUserId);
            console.log(`merge-user: Datos fusionados de ${opaqueId} -> ${realUserId}`);
        } catch (err) {
            console.error('merge-user: Error al fusionar usuarios:', err);
        }
    });

    socket.on('submit-answer', async (data) => {
        const { questionId, selectedOption, responseTime, twitchUserId } = data;

        // --- Validations ---
        if (responseTime === 0 || selectedOption === -1) {
            return;
        }
        if (!currentQuizSession.quizId || !currentQuizSession.currentQuestion || currentQuizSession.currentQuestion.id !== questionId) {
            return; // Answer is not for the current question, or no quiz/question active, ignore.
        }

        // --- User Identification and Merging Logic ---
        const isAnonymous = typeof twitchUserId === 'string' && twitchUserId.startsWith('U');
        const socketId = socket.id;
        let session = socketUserMap.get(socketId);
        let dbUserId;
        let finalDisplayName;

        // Fetch real display name if not anonymous
        const realDisplayName = isAnonymous ? null : await getTwitchDisplayName(twitchUserId);

        if (session) { // User has an existing session on this socket
            dbUserId = session.dbUserId;
            finalDisplayName = (await db.query('SELECT display_name FROM users WHERE id = $1', [dbUserId])).rows[0].display_name;

            // --- MERGE SCENARIO ---
            // Check if a previously anonymous user has now authenticated
            if (session.isAnonymous && !isAnonymous) {
                console.log(`User with socket ${socketId} has authenticated. Merging...`);
                const authUser = await findOrCreateUser(twitchUserId, realDisplayName);

                // Perform the merge if the DB IDs are different
                if (session.dbUserId !== authUser.id) {
                    await mergeUsers(session.dbUserId, authUser.id);
                    mergeInMemoryData(session.dbUserId, authUser.id);
                }

                // Release the anonymous number
                usedAnonymousNumbers.delete(session.anonymousNumber);
                nextAnonymousNumber = Math.min(nextAnonymousNumber, session.anonymousNumber);

                // Update the session to reflect authenticated state
                session.isAnonymous = false;
                session.dbUserId = authUser.id;
                session.anonymousNumber = null;
                socketUserMap.set(socketId, session);

                dbUserId = authUser.id;
                finalDisplayName = realDisplayName;
                console.log(`Merge complete for ${realDisplayName}.`);
            }
        } else { // First answer from this user on this socket
            if (isAnonymous) {
                const { dbUserId: anonDbUserId, displayName: anonDisplayName, anonymousNumber } = await createAnonymousUser(twitchUserId);
                dbUserId = anonDbUserId;
                finalDisplayName = anonDisplayName;
                socketUserMap.set(socketId, { dbUserId, isAnonymous: true, anonymousNumber });
            } else {
                const authUser = await findOrCreateUser(twitchUserId, realDisplayName);
                dbUserId = authUser.id;
                finalDisplayName = realDisplayName;
                socketUserMap.set(socketId, { dbUserId, isAnonymous: false, anonymousNumber: null });
            }
        }

        // Check if user has already answered this question
        if (currentQuizSession.currentQuestion.answers[dbUserId]) {
            return; // User already answered, ignore.
        }

        // Store answer in memory for quick processing
        currentQuizSession.currentQuestion.answers[dbUserId] = {
            selectedOption,
            responseTime,
            twitchUserId, // Keep original twitchUserId for this answer
            displayName: finalDisplayName
        };
        currentQuizSession.currentQuestion.receivedAnswerCount++;

        // --- Real-time update for control panel ---
        if (currentQuizSession.currentQuestion) {
            const liveResults = calculateRoundResults(
                currentQuizSession.currentQuestion.answers,
                currentQuizSession.currentQuestion.correct_option
            );

            // Calculate vote counts
            const voteCounts = { 0: 0, 1: 0, 2: 0, 3: 0, '-1': 0 };
            for (const userId in currentQuizSession.currentQuestion.answers) {
                const selectedOption = currentQuizSession.currentQuestion.answers[userId].selectedOption;
                if (voteCounts.hasOwnProperty(selectedOption)) {
                    voteCounts[selectedOption]++;
                }
            }

            if (controlPanelSocketId) {
                io.to(controlPanelSocketId).emit("live-round-update", {
                    roundResults: liveResults,
                    voteCounts: voteCounts
                });
            } else {
                console.warn("Control Panel not registered. Cannot send live-round-update.");
            }
        }

        console.log(`Answer received from ${finalDisplayName} (Twitch: ${twitchUserId}). Answers received: ${currentQuizSession.currentQuestion.receivedAnswerCount}/${currentQuizSession.currentQuestion.expectedAnswerCount}`);

        // Log when all expected answers have been received
        if (currentQuizSession.currentQuestion.receivedAnswerCount >= currentQuizSession.currentQuestion.expectedAnswerCount) {
            console.log("All expected answers received. Waiting for submission window to close.");
        }
    });

    socket.on("disconnect", () => {
        console.log(`Client disconnected: ${socket.id}`);

        // --- User Session Cleanup ---
        const session = socketUserMap.get(socket.id);
        if (session && session.isAnonymous) {
            usedAnonymousNumbers.delete(session.anonymousNumber);
            nextAnonymousNumber = Math.min(nextAnonymousNumber, session.anonymousNumber);
            console.log(`Released anonymous number ${session.anonymousNumber}. Next available: ${nextAnonymousNumber}`);
        }
        socketUserMap.delete(socket.id);
        // --- End User Session Cleanup ---

        if (socket.id === controlPanelSocketId) {
            controlPanelSocketId = null;
            console.log("Control Panel disconnected. controlPanelSocketId cleared.");
        } else {
            activeParticipantSocketIds.delete(socket.id);
            console.log(`Participant disconnected: ${socket.id}. Total participants: ${activeParticipantSocketIds.size}`);
        }
    });

});





// --- Server Initialization ---
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`✅ Backend running on port ${PORT}`);
    initializeAnonymousUserTracking();
});

module.exports = { app, server };