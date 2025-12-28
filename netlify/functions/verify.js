// /netlify/functions/verify.js

const { Pool } = require("pg");

// Initialize the Postgres Pool using the connection string from environment variables
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false, // Required for Neon connections
  },
});

/**
 * Ensures the required table exists in the database.
 * This runs on every cold start of the serverless function.
 */
async function initializeDatabase() {
  const createTableQuery = `
    CREATE TABLE IF NOT EXISTS license_codes (
      id SERIAL PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      is_used BOOLEAN DEFAULT false,
      machine_id TEXT,
      used_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `;
  try {
    await pool.query(createTableQuery);
  } catch (err) {
    console.error("Error initializing database table:", err);
    throw err;
  }
}

exports.handler = async function (event, context) {
  // CORS headers
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ success: false, message: "Method Not Allowed" }),
    };
  }

  try {
    // Ensure table exists before processing request
    await initializeDatabase();

    const { licenseCode, machineId } = JSON.parse(event.body);

    if (!licenseCode || !machineId) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          success: false,
          message: "License code and machine ID are required.",
        }),
      };
    }

    // 1. Query the database for the license code
    const selectQuery = `
      SELECT id, code, is_used, machine_id 
      FROM license_codes 
      WHERE code = $1 
      LIMIT 1
    `;

    const res = await pool.query(selectQuery, [licenseCode.trim()]);
    const codeData = res.rows[0];

    // 2. If code doesn't exist
    if (!codeData) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({
          success: false,
          message: "Invalid license code.",
        }),
      };
    }

    // 3. Logic Validation
    if (codeData.is_used) {
      // Check if it matches the current machine
      if (codeData.machine_id === machineId) {
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            success: true,
            message: "License verified successfully.",
          }),
        };
      } else {
        return {
          statusCode: 403,
          headers,
          body: JSON.stringify({
            success: false,
            message: "This license has already been used on another computer.",
          }),
        };
      }
    } else {
      // 4. First-time Activation
      const updateQuery = `
        UPDATE license_codes 
        SET is_used = true, 
            used_at = NOW(), 
            machine_id = $1 
        WHERE id = $2
      `;

      await pool.query(updateQuery, [machineId, codeData.id]);

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          message: "Application activated successfully.",
        }),
      };
    }
  } catch (error) {
    console.error("Database or Server Error:", error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        success: false,
        message: "An unexpected error occurred.",
      }),
    };
  }
};
