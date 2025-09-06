require("dotenv").config();
const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");

const triviaRoutes = require("./triviaRoutes");

const app = express();
app.use(cors());
app.use(express.json());

// Middleware para validar token de Twitch Extension
app.use((req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).send("Missing authorization header");

    const token = authHeader.split(" ")[1];
    if (!token) return res.status(401).send("Malformed authorization header");

    try {
        // El secret de la extensión de Twitch viene en Base64, hay que decodificarlo.
        const secret = Buffer.from(process.env.EXT_SECRET, "base64");
        const decoded = jwt.verify(token, secret, {
            algorithms: ["HS256"],
        });
        req.twitch = decoded;
        next();
    } catch (err) {
        console.error("Invalid JWT:", err.message);
        return res.status(403).send("Invalid or expired JWT");
    }
});

app.use("/trivia", triviaRoutes);

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`✅ Backend running on port ${PORT}`));
