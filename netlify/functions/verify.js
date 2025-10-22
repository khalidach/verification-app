// netlify/functions/verify.js

// Load environment variables from .env file (for local testing)
// On Netlify, variables are set in the UI (see Step 4)
require("dotenv").config();

const { createClient } = require("@supabase/supabase-js");

// Check for environment variables
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
  // This will fail the function build or execution
  // and show an error in the Netlify function logs
  console.error("Error: SUPABASE_URL and SUPABASE_ANON_KEY must be set.");
  // We return a 500 status here for the client
  return {
    statusCode: 500,
    body: JSON.stringify({
      valid: false,
      message: "Server configuration error.",
    }),
  };
}

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// This is the main serverless function handler
exports.handler = async (event, context) => {
  // Ensure the request is a POST request
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: JSON.stringify({ valid: false, message: "Method Not Allowed" }),
    };
  }

  let licenseCode;
  try {
    // Parse the incoming request body
    const body = JSON.parse(event.body);
    licenseCode = body.licenseCode;
  } catch (e) {
    return {
      statusCode: 400,
      body: JSON.stringify({ valid: false, message: "Invalid request body." }),
    };
  }

  if (!licenseCode) {
    return {
      statusCode: 400,
      body: JSON.stringify({
        valid: false,
        message: "License code is required.",
      }),
    };
  }

  // This is the exact same try/catch block from your server.js
  try {
    const { data, error } = await supabase
      .from("license_codes")
      .select("code")
      .eq("code", licenseCode)
      .single();

    if (error) {
      console.log("Supabase query error (or code not found):", error.message);
      return {
        statusCode: 404,
        body: JSON.stringify({
          valid: false,
          message: "License code not found or invalid.",
        }),
      };
    }

    if (data) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          valid: true,
          message: "License verified successfully.",
        }),
      };
    } else {
      return {
        statusCode: 404,
        body: JSON.stringify({
          valid: false,
          message: "License code not found.",
        }),
      };
    }
  } catch (err) {
    console.error("Internal server error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ valid: false, message: "Internal server error." }),
    };
  }
};
