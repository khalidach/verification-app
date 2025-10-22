// Load environment variables from .env file
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const { createClient } = require("@supabase/supabase-js");

// Check for environment variables
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
  console.error(
    "Error: SUPABASE_URL and SUPABASE_ANON_KEY must be set in your .env file."
  );
  process.exit(1);
}

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const app = express();
app.use(cors());
app.use(bodyParser.json());

const PORT = process.env.PORT || 3002;

/**
 * API Endpoint: /api/verify
 * Verifies a license code against the Supabase database.
 */
app.post("/api/verify", async (req, res) => {
  const { licenseCode } = req.body;

  if (!licenseCode) {
    return res
      .status(400)
      .json({ valid: false, message: "License code is required." });
  }

  try {
    // Query the 'license_codes' table in Supabase
    const { data, error } = await supabase
      .from("license_codes") // The table we created
      .select("code") // Select the code column
      .eq("code", licenseCode) // Where code equals the one provided
      .single(); // Expect exactly one or zero rows

    if (error) {
      // This error (code 'PGRST116') is triggered by .single() if no row is found.
      // This is the expected behavior for an invalid code.
      console.log("Supabase query error (or code not found):", error.message);
      return res
        .status(404)
        .json({ valid: false, message: "License code not found or invalid." });
    }

    if (data) {
      // Success! The code exists.
      return res.json({
        valid: true,
        message: "License verified successfully.",
      });
    } else {
      // Fallback in case .single() returns null data but no error
      return res
        .status(404)
        .json({ valid: false, message: "License code not found." });
    }
  } catch (err) {
    // Catch any other unexpected server errors
    console.error("Internal server error:", err);
    return res
      .status(500)
      .json({ valid: false, message: "Internal server error." });
  }
});

app.listen(PORT, () => {
  console.log(
    `Verification service (Supabase) running on http://localhost:${PORT}`
  );
});
