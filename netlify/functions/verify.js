// /netlify/functions/verify.js
const { Pool } = require("pg");
const crypto = require("crypto");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
    sslmode: "verify-full",
  },
});

const getFormattedKey = (key) => {
  if (!key) return null;
  return key.replace(/\\n/g, "\n");
};

const PRIVATE_KEY = getFormattedKey(process.env.LICENSE_PRIVATE_KEY);

function signResponse(success, message, machineId, isTrial = false) {
  if (!PRIVATE_KEY) {
    console.error("Missing LICENSE_PRIVATE_KEY");
    return null;
  }

  const payload = JSON.stringify({
    success,
    message,
    machineId,
    isTrial, // Include trial status in signature for client-side security
  });

  try {
    const signer = crypto.createSign("SHA256");
    signer.update(payload);
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
      created_at TIMESTAMP DEFAULT NOW(),
      is_trial BOOLEAN DEFAULT false,
      trial_expires_at TIMESTAMP
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
          message: "License code and machine ID required.",
        }),
      };
    }

    const selectQuery = `SELECT * FROM license_codes WHERE code = $1 LIMIT 1`;
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

    // 2. Handle Already Activated/Used Codes
    if (codeData.is_used) {
      if (codeData.machine_id !== machineId) {
        const msg = "This license is already used on another device.";
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

      // Check if it's a trial code and if it expired
      if (codeData.is_trial) {
        const now = new Date();
        const expiry = new Date(codeData.trial_expires_at);

        if (now > expiry) {
          const msg =
            "Trial period has expired. Please upgrade to a lifetime license.";
          return {
            statusCode: 402, // Payment Required / Expired
            headers,
            body: JSON.stringify({
              success: false,
              message: msg,
              signature: signResponse(false, msg, machineId, true),
            }),
          };
        } else {
          const msg = `Trial active. Expires in ${Math.round((expiry - now) / 36e5)} hours.`;
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
              success: true,
              message: msg,
              signature: signResponse(true, msg, machineId, true),
            }),
          };
        }
      }

      // Lifetime license check
      const msg = "License verified successfully.";
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          message: msg,
          signature: signResponse(true, msg, machineId, false),
        }),
      };
    }

    // 3. New Activation Logic
    // If the code starts with 'TRIAL-', we set expiration to 24 hours from now
    const isTrialCode = codeData.code.startsWith("TRIAL-");
    const trialExpiry = isTrialCode ? "NOW() + INTERVAL '1 day'" : "NULL";

    const updateQuery = `
      UPDATE license_codes 
      SET is_used = true, 
          used_at = NOW(), 
          machine_id = $1, 
          is_trial = $2, 
          trial_expires_at = ${trialExpiry} 
      WHERE id = $3
    `;

    await pool.query(updateQuery, [machineId, isTrialCode, codeData.id]);

    const msg = isTrialCode
      ? "Trial activated for 24 hours."
      : "Lifetime license activated successfully.";
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        message: msg,
        signature: signResponse(true, msg, machineId, isTrialCode),
      }),
    };
  } catch (error) {
    console.error("Server Error:", error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ success: false, message: "Server error." }),
    };
  }
};
