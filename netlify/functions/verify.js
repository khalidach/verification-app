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

/**
 * Signs the response payload to prevent client-side tampering.
 * Includes expiryDate and isTrial status in the signature.
 */
function signResponse(
  success,
  message,
  machineId,
  isTrial = false,
  expiryDate = null,
) {
  if (!PRIVATE_KEY) {
    console.error("Missing LICENSE_PRIVATE_KEY");
    return null;
  }

  const payload = JSON.stringify({
    success,
    message,
    machineId,
    isTrial,
    expiryDate,
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

/**
 * Ensures the table exists and contains the necessary trial columns.
 */
async function initializeDatabase() {
  const query = `
    -- 1. Create the table if it doesn't exist
    CREATE TABLE IF NOT EXISTS license_codes (
      id SERIAL PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      is_used BOOLEAN DEFAULT false,
      machine_id TEXT,
      used_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    );

    -- 2. Add trial columns if they are missing from an existing table
    ALTER TABLE license_codes ADD COLUMN IF NOT EXISTS is_trial BOOLEAN DEFAULT false;
    ALTER TABLE license_codes ADD COLUMN IF NOT EXISTS trial_expires_at TIMESTAMP;
  `;
  try {
    await pool.query(query);
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

      if (codeData.is_trial) {
        const now = new Date();
        const expiry = new Date(codeData.trial_expires_at);

        if (now > expiry) {
          const msg =
            "Trial period has expired. Please upgrade to a lifetime license.";
          return {
            statusCode: 402,
            headers,
            body: JSON.stringify({
              success: false,
              message: msg,
              isTrial: true,
              expiryDate: expiry.toISOString(),
              signature: signResponse(
                false,
                msg,
                machineId,
                true,
                expiry.toISOString(),
              ),
            }),
          };
        } else {
          // Changed to minutes for testing
          const minutesLeft = Math.max(0, Math.round((expiry - now) / 60000));
          const msg = `Trial active. Expires in ${minutesLeft} minutes.`;
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
              success: true,
              message: msg,
              isTrial: true,
              expiryDate: expiry.toISOString(),
              signature: signResponse(
                true,
                msg,
                machineId,
                true,
                expiry.toISOString(),
              ),
            }),
          };
        }
      }

      const msg = "License verified successfully.";
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          message: msg,
          isTrial: false,
          expiryDate: null,
          signature: signResponse(true, msg, machineId, false, null),
        }),
      };
    }

    // 3. New Activation Logic
    const isTrialCode = codeData.code.startsWith("TRIAL-");

    // Calculate expiry locally (10 minutes for testing)
    const expiryDateValue = isTrialCode
      ? new Date(Date.now() + 10 * 60 * 1000).toISOString()
      : null;

    // Changed INTERVAL '1 day' to '10 minutes'
    const trialExpirySql = isTrialCode
      ? "NOW() + INTERVAL '10 minutes'"
      : "NULL";

    const updateQuery = `
      UPDATE license_codes 
      SET is_used = true, 
          used_at = NOW(), 
          machine_id = $1, 
          is_trial = $2, 
          trial_expires_at = ${trialExpirySql} 
      WHERE id = $3
    `;

    await pool.query(updateQuery, [machineId, isTrialCode, codeData.id]);

    const msg = isTrialCode
      ? "Trial activated for 10 minutes."
      : "Lifetime license activated successfully.";

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        message: msg,
        isTrial: isTrialCode,
        expiryDate: expiryDateValue,
        signature: signResponse(
          true,
          msg,
          machineId,
          isTrialCode,
          expiryDateValue,
        ),
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
