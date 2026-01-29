// /netlify/functions/verify.js
const { Pool } = require("pg");
const crypto = require("crypto");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
    // Fix for the pg-connection-string warning in your logs
    sslmode: "verify-full",
  },
});

/**
 * Fixes the private key formatting.
 * Environment variables often escape newlines as "\n".
 */
const getFormattedKey = (key) => {
  if (!key) return null;
  // Replace literal '\n' strings with actual newline characters
  return key.replace(/\\n/g, "\n");
};

const PRIVATE_KEY = getFormattedKey(process.env.LICENSE_PRIVATE_KEY);

function signResponse(success, message, machineId) {
  if (!PRIVATE_KEY) {
    console.error(
      "Missing or malformed LICENSE_PRIVATE_KEY environment variable.",
    );
    return null;
  }

  const payload = JSON.stringify({
    success,
    message,
    machineId,
  });

  try {
    const signer = crypto.createSign("SHA256");
    signer.update(payload);
    // The error was happening here because PRIVATE_KEY was likely a flat string
    return signer.sign(PRIVATE_KEY, "base64");
  } catch (err) {
    console.error("Signing Error:", err.message);
    return null;
  }
}

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
    console.error("Database initialization error:", err);
    throw err;
  }
}

exports.handler = async function (event, context) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  if (event.httpMethod === "OPTIONS")
    return { statusCode: 204, headers, body: "" };

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ success: false, message: "Method Not Allowed" }),
    };
  }

  try {
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

    const selectQuery = `SELECT id, code, is_used, machine_id FROM license_codes WHERE code = $1 LIMIT 1`;
    const res = await pool.query(selectQuery, [licenseCode.trim()]);
    const codeData = res.rows[0];

    // 1. Invalid Code
    if (!codeData) {
      const msg = "Invalid license code.";
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({
          success: false,
          message: msg,
          signature: signResponse(false, msg, machineId),
        }),
      };
    }

    // 2. Already Activated
    if (codeData.is_used) {
      if (codeData.machine_id === machineId) {
        const msg = "License verified successfully.";
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            success: true,
            message: msg,
            signature: signResponse(true, msg, machineId),
          }),
        };
      } else {
        const msg = "This license has already been used on another computer.";
        return {
          statusCode: 403,
          headers,
          body: JSON.stringify({
            success: false,
            message: msg,
            signature: signResponse(false, msg, machineId),
          }),
        };
      }
    }

    // 3. New Activation
    const updateQuery = `UPDATE license_codes SET is_used = true, used_at = NOW(), machine_id = $1 WHERE id = $2`;
    await pool.query(updateQuery, [machineId, codeData.id]);

    const msg = "Application activated successfully.";
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        message: msg,
        signature: signResponse(true, msg, machineId),
      }),
    };
  } catch (error) {
    console.error("Server Error:", error);
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
