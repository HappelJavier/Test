const express = require("express");
const router = express.Router();

// Ejemplo: preguntas en memoria
let questions = [
    { id: 1, q: "¿Cuál es la capital de Japón?", a: ["Tokio", "Osaka", "Kioto"], correct: 0 },
    { id: 2, q: "¿Quién creó Twitch?", a: ["Justin Kan", "Elon Musk", "Bill Gates"], correct: 0 }
];

router.get("/", (req, res) => {
    res.json(questions);
});

router.post("/answer", (req, res) => {
    const { questionId, answerIndex } = req.body;
    const question = questions.find(q => q.id === questionId);
    if (!question) return res.status(404).json({ error: "Pregunta no encontrada" });

    const correct = question.correct === answerIndex;
    res.json({ correct });
});

module.exports = router;
