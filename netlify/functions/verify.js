// /netlify/functions/verify.js

// Import the Supabase client library
const { createClient } = require("@supabase/supabase-js");

// The main handler for the Netlify serverless function.
exports.handler = async function (event, context) {
  // CORS headers to allow requests from your application
  const headers = {
    "Access-Control-Allow-Origin": "*", // Or lock down to your specific domain
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  // Handle pre-flight OPTIONS requests (for CORS)
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers,
      body: "",
    };
  }

  // Ensure the request is a POST request
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ success: false, message: "Method Not Allowed" }),
    };
  }

  try {
    // --- 1. Initialize Supabase Client ---
    // Get environment variables
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

    // Check if variables are set
    if (!supabaseUrl || !supabaseAnonKey) {
      console.error("Supabase URL or Anon Key is not set.");
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({
          success: false,
          message: "Server configuration error.",
        }),
      };
    }
    // Initialize the client
    const supabase = createClient(supabaseUrl, supabaseAnonKey);

    // --- 2. Get Code and Machine ID from Request ---
    // We expect "licenseCode" (from your original logic) and "machineId" (from new logic)
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

    // --- 3. Query Supabase for the Code ---
    // We query your original "license_codes" table
    // We must select all fields needed for the logic (id, is_used, machine_id)
    const { data: codeData, error: selectError } = await supabase
      .from("license_codes") // Using your original table name
      .select("id, code, is_used, machine_id")
      .eq("code", licenseCode.trim()) // Using your original field name "code"
      .single();

    // Handle errors during the select query
    // PGRST116 means "No rows found", which we handle as "invalid code"
    if (selectError && selectError.code !== "PGRST116") {
      console.error("Supabase select error:", selectError);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({
          success: false,
          message: "Database query failed.",
        }),
      };
    }

    // If code doesn't exist at all (PGRST116 or no data)
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

    // --- 4. Validate the Code (The new logic) ---
    if (codeData.is_used) {
      // If the code is used, check if it's for the same machine
      if (codeData.machine_id === machineId) {
        // It's the same machine re-verifying, which is allowed.
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            success: true,
            message: "License verified successfully.",
          }),
        };
      } else {
        // The code is used, but on a different machine. Deny access.
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
      // --- 5. First-Time Activation: Mark the Code as Used ---
      // This is a new, unused code. We will activate it.
      const { error: updateError } = await supabase
        .from("license_codes") // Update your original table
        .update({
          is_used: true,
          used_at: new Date().toISOString(),
          machine_id: machineId, // Store the machine ID
        })
        .eq("id", codeData.id); // Match by its unique ID

      if (updateError) {
        console.error("Supabase update error:", updateError);
        return {
          statusCode: 500,
          headers,
          body: JSON.stringify({
            success: false,
            message: "Failed to activate license.",
          }),
        };
      }

      // --- 6. Return Success Response for First-Time Activation ---
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
    // Catch any unexpected errors (e.g., JSON parsing failed)
    console.error("Unexpected server error:", error);
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
