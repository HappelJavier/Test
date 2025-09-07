const { Pool } = require('pg');

// The Pool constructor will automatically use the DATABASE_URL environment
// variable if it's available, which is perfect for services like Render.
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // Heroku/Render and other services provide a DATABASE_URL
    // which includes SSL configuration. For local development, you might
    // need to turn SSL off.
        ssl: {
        rejectUnauthorized: false,
    },
});

// We export a query function that logs the query and uses the pool to execute it.
// This is a simple way to centralize database access.
module.exports = {
    query: (text, params) => pool.query(text, params),
};
