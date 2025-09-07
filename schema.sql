-- schema.sql for QuizKyot
-- This file defines the structure of the PostgreSQL database.

-- Drop tables if they exist to ensure a clean slate
DROP TABLE IF EXISTS responses CASCADE;
DROP TABLE IF EXISTS quiz_questions CASCADE;
DROP TABLE IF EXISTS quiz_instances CASCADE;
DROP TABLE IF EXISTS users CASCADE;
DROP TABLE IF EXISTS questions CASCADE;
DROP TABLE IF EXISTS quizzes CASCADE;

-- Table for storing global, reusable questions
CREATE TABLE questions (
    id SERIAL PRIMARY KEY,
    text VARCHAR(255) NOT NULL,
    options TEXT[] NOT NULL, -- Array of 4 text options
    correct_option INTEGER NOT NULL, -- Index of the correct answer (0-3)
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Table for storing quizzes, which are collections of questions
CREATE TABLE quizzes (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    last_activated_at TIMESTAMP WITH TIME ZONE
);

-- Table for storing specific instances (runs) of a quiz
CREATE TABLE quiz_instances (
    id SERIAL PRIMARY KEY,
    quiz_id INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
    start_time TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    end_time TIMESTAMP WITH TIME ZONE
);

-- Junction table to link questions to quizzes and set a specific time limit
-- This allows a question to be reused in multiple quizzes with different timers.
CREATE TABLE quiz_questions (
    id SERIAL PRIMARY KEY,
    quiz_id INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
    question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    time_limit INTEGER NOT NULL, -- Time limit in seconds for this specific instance
    -- Optional: add an order field if you want to force a specific question order
    display_order INTEGER NOT NULL DEFAULT 0
);

-- Table for storing user information
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    twitch_user_id VARCHAR(255) UNIQUE NOT NULL,
    display_name VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Table for storing every single response from a user for a question in a quiz
CREATE TABLE responses (
    id SERIAL PRIMARY KEY,
    quiz_instance_id INTEGER NOT NULL REFERENCES quiz_instances(id) ON DELETE CASCADE, -- New column
    quiz_id INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
    question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    selected_option INTEGER NOT NULL,
    response_time_ms INTEGER NOT NULL, -- Response time in milliseconds
    score NUMERIC(10,2) NOT NULL, -- Changed to NUMERIC based on user's previous fix
    is_correct BOOLEAN NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Optional: Indexes can be added to improve query performance on foreign keys
CREATE INDEX ON quiz_questions (quiz_id);
CREATE INDEX ON quiz_questions (question_id);
CREATE INDEX ON responses (quiz_id);
CREATE INDEX ON responses (question_id);
CREATE INDEX ON responses (user_id);
CREATE INDEX ON responses (quiz_instance_id);
