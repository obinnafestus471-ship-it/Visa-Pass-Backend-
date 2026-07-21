// =============================================
// server.js - VisaPass Backend for Deno Deploy
// Converted from Cloudflare Workers
// =============================================

import express from "npm:express";
import cors from "npm:cors";
import crypto from "npm:crypto";
import { createClient } from "npm:@supabase/supabase-js";
import { GoogleGenerativeAI } from "npm:@google/generative-ai";
import "npm:dotenv/config";

const app = express();

// =============================================
// MIDDLEWARE
// =============================================
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

console.log("✅ VisaPass Backend Starting on Deno Deploy...");

// =============================================
// ENVIRONMENT VARIABLES (Deno way)
// =============================================
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_KEY");
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
const FIREBASE_API_KEY = Deno.env.get("FIREBASE_API_KEY");
const FIREBASE_PROJECT_ID = Deno.env.get("FIREBASE_PROJECT_ID");
const FIREBASE_CLIENT_EMAIL = Deno.env.get("FIREBASE_CLIENT_EMAIL");
const PAYSTACK_SECRET_KEY = Deno.env.get("PAYSTACK_SECRET_KEY");
const FRONTEND_URL = Deno.env.get("FRONTEND_URL") || "http://localhost:3000";
const PORT = Deno.env.get("PORT") || 5000;

// =============================================
// SUPABASE
// =============================================
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
console.log("✅ Supabase connected!");

// =============================================
// GEMINI
// =============================================
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
console.log("✅ Gemini configured!");

// =============================================
// ADMIN CONFIG
// =============================================
const ADMIN_EMAILS = ["obinnafestus471@gmail.com", "admin@visapass.com"];
const ADMIN_PASSWORD = "VisaPassAdmin123";

function isAdmin(req, res, next) {
  const userEmail = req.headers["x-user-email"] || req.query.email;
  if (ADMIN_EMAILS.includes(userEmail)) {
    return next();
  }
  res.status(403).json({
    success: false,
    error: "🚫 Admin access required!"
  });
}

// =============================================
// API LIMIT TRACKING
// =============================================
let apiUsage = {
  dailyRequests: 0,
  lastReset: new Date(),
  isLimited: false,
  limit: 1500
};

function resetDailyUsage() {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  if (now > midnight && apiUsage.lastReset < midnight) {
    apiUsage.dailyRequests = 0;
    apiUsage.isLimited = false;
    apiUsage.lastReset = now;
    console.log("🔄 Gemini API limit reset!");
  }
}

function isApiAvailable() {
  resetDailyUsage();
  return !apiUsage.isLimited;
}

// =============================================
// HELPER: Supabase Request
// =============================================
async function supabaseRequest(endpoint, options = {}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${endpoint}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "apikey": SUPABASE_SERVICE_KEY,
      "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`,
      ...options.headers
    }
  });
  return response.json();
}

// =============================================
// HELPER: Call Gemini
// =============================================
async function callGemini(prompt) {
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }]
        })
      }
    );
    const data = await response.json();
    return data.candidates[0].content.parts[0].text;
  } catch (error) {
    throw new Error("Gemini API error: " + error.message);
  }
}

// =============================================
// HELPER: Firebase REST API
// =============================================
async function firebaseRequest(endpoint, options = {}) {
  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/${endpoint}?key=${FIREBASE_API_KEY}`,
    {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...options.headers
      }
    }
  );
  return response.json();
}

// =============================================
// HELPER: Get Firebase Access Token
// =============================================
async function getFirebaseAccessToken() {
  const response = await fetch(
    `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${FIREBASE_CLIENT_EMAIL}:generateAccessToken`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope: ["https://www.googleapis.com/auth/cloud-platform"],
      }),
    }
  );
  const data = await response.json();
  return data.accessToken;
}

// =============================================
// HELPER: Send Push Notification
// =============================================
async function sendPushNotification(fcmToken, title, body, data = {}) {
  try {
    const accessToken = await getFirebaseAccessToken();
    const response = await fetch(
      `https://fcm.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/messages:send`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${accessToken}`
        },
        body: JSON.stringify({
          message: {
            token: fcmToken,
            notification: { title, body },
            data: data
          }
        })
      }
    );
    return response.json();
  } catch (error) {
    console.error("Push notification error:", error);
    return null;
  }
}

// =============================================
// HELPER: Save Notification to Firestore
// =============================================
async function saveNotification(userId, email, title, body, type = "admin") {
  try {
    const accessToken = await getFirebaseAccessToken();
    const response = await fetch(
      `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/notifications`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${accessToken}`
        },
        body: JSON.stringify({
          fields: {
            userId: { stringValue: userId },
            email: { stringValue: email },
            title: { stringValue: title },
            body: { stringValue: body },
            type: { stringValue: type },
            read: { booleanValue: false },
            createdAt: { timestampValue: new Date().toISOString() }
          }
        })
      }
    );
    return response.json();
  } catch (error) {
    console.error("Save notification error:", error);
    return null;
  }
}

// =============================================
// HELPER: Get User by Email from Firestore
// =============================================
async function getUserByEmail(email) {
  try {
    const accessToken = await getFirebaseAccessToken();
    const response = await fetch(
      `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents:runQuery`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${accessToken}`
        },
        body: JSON.stringify({
          structuredQuery: {
            from: [{ collectionId: "users" }],
            where: {
              fieldFilter: {
                field: { fieldPath: "email" },
                op: "EQUAL",
                value: { stringValue: email }
              }
            }
          }
        })
      }
    );
    const data = await response.json();
    if (data.length > 0 && data[0].document) {
      const doc = data[0].document;
      const fields = doc.fields || {};
      return {
        id: doc.name.split("/").pop(),
        fcmToken: fields.fcmToken?.stringValue || null,
        email: fields.email?.stringValue || null,
        name: fields.name?.stringValue || "User"
      };
    }
    return null;
  } catch (error) {
    console.error("Get user by email error:", error);
    return null;
  }
}

// =============================================
// HELPER: Check User Payment
// =============================================
async function checkUserPayment(userEmail) {
  try {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    
    const data = await supabaseRequest(`payments?user_email=eq.${encodeURIComponent(userEmail)}&status=eq.success&created_at=gte.${thirtyDaysAgo.toISOString()}&order=created_at.desc&limit=1`);
    
    if (data && data.length > 0) {
      return { hasPaid: true, payment: data[0] };
    }
    return { hasPaid: false, payment: null };
  } catch (error) {
    console.error("Payment check error:", error);
    return { hasPaid: false, payment: null };
  }
}

// =============================================
// 130 COUNTRIES
// =============================================
const allCountries = [
  { name: "United States", flag: "🇺🇸" },
  { name: "United Kingdom", flag: "🇬🇧" },
  { name: "Canada", flag: "🇨🇦" },
  { name: "Germany", flag: "🇩🇪" },
  { name: "France", flag: "🇫🇷" },
  { name: "Italy", flag: "🇮🇹" },
  { name: "Spain", flag: "🇪🇸" },
  { name: "Netherlands", flag: "🇳🇱" },
  { name: "Portugal", flag: "🇵🇹" },
  { name: "Greece", flag: "🇬🇷" },
  { name: "Switzerland", flag: "🇨🇭" },
  { name: "Belgium", flag: "🇧🇪" },
  { name: "Sweden", flag: "🇸🇪" },
  { name: "Denmark", flag: "🇩🇰" },
  { name: "Austria", flag: "🇦🇹" },
  { name: "Norway", flag: "🇳🇴" },
  { name: "Finland", flag: "🇫🇮" },
  { name: "Ireland", flag: "🇮🇪" },
  { name: "Poland", flag: "🇵🇱" },
  { name: "Czech Republic", flag: "🇨🇿" },
  { name: "Hungary", flag: "🇭🇺" },
  { name: "Romania", flag: "🇷🇴" },
  { name: "Bulgaria", flag: "🇧🇬" },
  { name: "Croatia", flag: "🇭🇷" },
  { name: "Slovenia", flag: "🇸🇮" },
  { name: "Slovakia", flag: "🇸🇰" },
  { name: "Lithuania", flag: "🇱🇹" },
  { name: "Latvia", flag: "🇱🇻" },
  { name: "Estonia", flag: "🇪🇪" },
  { name: "Luxembourg", flag: "🇱🇺" },
  { name: "Malta", flag: "🇲🇹" },
  { name: "Cyprus", flag: "🇨🇾" },
  { name: "Iceland", flag: "🇮🇸" },
  { name: "Liechtenstein", flag: "🇱🇮" },
  { name: "Andorra", flag: "🇦🇩" },
  { name: "Monaco", flag: "🇲🇨" },
  { name: "San Marino", flag: "🇸🇲" },
  { name: "Vatican City", flag: "🇻🇦" },
  { name: "Ukraine", flag: "🇺🇦" },
  { name: "Belarus", flag: "🇧🇾" },
  { name: "Moldova", flag: "🇲🇩" },
  { name: "Bosnia & Herzegovina", flag: "🇧🇦" },
  { name: "Albania", flag: "🇦🇱" },
  { name: "North Macedonia", flag: "🇲🇰" },
  { name: "Montenegro", flag: "🇲🇪" },
  { name: "Serbia", flag: "🇷🇸" },
  { name: "United Arab Emirates", flag: "🇦🇪" },
  { name: "Saudi Arabia", flag: "🇸🇦" },
  { name: "Turkey", flag: "🇹🇷" },
  { name: "China", flag: "🇨🇳" },
  { name: "India", flag: "🇮🇳" },
  { name: "Japan", flag: "🇯🇵" },
  { name: "South Korea", flag: "🇰🇷" },
  { name: "Malaysia", flag: "🇲🇾" },
  { name: "Thailand", flag: "🇹🇭" },
  { name: "Indonesia", flag: "🇮🇩" },
  { name: "Singapore", flag: "🇸🇬" },
  { name: "Philippines", flag: "🇵🇭" },
  { name: "Vietnam", flag: "🇻🇳" },
  { name: "Pakistan", flag: "🇵🇰" },
  { name: "Bangladesh", flag: "🇧🇩" },
  { name: "Sri Lanka", flag: "🇱🇰" },
  { name: "Nepal", flag: "🇳🇵" },
  { name: "Myanmar", flag: "🇲🇲" },
  { name: "Cambodia", flag: "🇰🇭" },
  { name: "Laos", flag: "🇱🇦" },
  { name: "Mongolia", flag: "🇲🇳" },
  { name: "Jordan", flag: "🇯🇴" },
  { name: "Lebanon", flag: "🇱🇧" },
  { name: "Israel", flag: "🇮🇱" },
  { name: "Palestine", flag: "🇵🇸" },
  { name: "Kuwait", flag: "🇰🇼" },
  { name: "Qatar", flag: "🇶🇦" },
  { name: "Oman", flag: "🇴🇲" },
  { name: "Bahrain", flag: "🇧🇭" },
  { name: "Yemen", flag: "🇾🇪" },
  { name: "Syria", flag: "🇸🇾" },
  { name: "Iraq", flag: "🇮🇶" },
  { name: "Iran", flag: "🇮🇷" },
  { name: "Afghanistan", flag: "🇦🇫" },
  { name: "Uzbekistan", flag: "🇺🇿" },
  { name: "Kazakhstan", flag: "🇰🇿" },
  { name: "Kyrgyzstan", flag: "🇰🇬" },
  { name: "Tajikistan", flag: "🇹🇯" },
  { name: "Turkmenistan", flag: "🇹🇲" },
  { name: "Azerbaijan", flag: "🇦🇿" },
  { name: "Georgia", flag: "🇬🇪" },
  { name: "Armenia", flag: "🇦🇲" },
  { name: "Australia", flag: "🇦🇺" },
  { name: "New Zealand", flag: "🇳🇿" },
  { name: "Papua New Guinea", flag: "🇵🇬" },
  { name: "South Africa", flag: "🇿🇦" },
  { name: "Egypt", flag: "🇪🇬" },
  { name: "Morocco", flag: "🇲🇦" },
  { name: "Algeria", flag: "🇩🇿" },
  { name: "Tunisia", flag: "🇹🇳" },
  { name: "Libya", flag: "🇱🇾" },
  { name: "Sudan", flag: "🇸🇩" },
  { name: "South Sudan", flag: "🇸🇸" },
  { name: "Eritrea", flag: "🇪🇷" },
  { name: "Ethiopia", flag: "🇪🇹" },
  { name: "Somalia", flag: "🇸🇴" },
  { name: "Djibouti", flag: "🇩🇯" },
  { name: "Comoros", flag: "🇰🇲" },
  { name: "Madagascar", flag: "🇲🇬" },
  { name: "Angola", flag: "🇦🇴" },
  { name: "DR Congo", flag: "🇨🇩" },
  { name: "Cuba", flag: "🇨🇺" },
  { name: "Jamaica", flag: "🇯🇲" },
  { name: "Dominican Republic", flag: "🇩🇴" },
  { name: "Bahamas", flag: "🇧🇸" },
  { name: "Haiti", flag: "🇭🇹" },
  { name: "Barbados", flag: "🇧🇧" },
  { name: "Trinidad & Tobago", flag: "🇹🇹" },
  { name: "St. Lucia", flag: "🇱🇨" },
  { name: "St. Vincent", flag: "🇻🇨" },
  { name: "Dominica", flag: "🇩🇲" },
  { name: "Mexico", flag: "🇲🇽" },
  { name: "Brazil", flag: "🇧🇷" },
  { name: "Argentina", flag: "🇦🇷" },
  { name: "Chile", flag: "🇨🇱" },
  { name: "Peru", flag: "🇵🇪" },
  { name: "Colombia", flag: "🇨🇴" },
  { name: "Venezuela", flag: "🇻🇪" },
  { name: "Ecuador", flag: "🇪🇨" },
  { name: "Bolivia", flag: "🇧🇴" },
  { name: "Paraguay", flag: "🇵🇾" },
  { name: "Uruguay", flag: "🇺🇾" },
  { name: "Guyana", flag: "🇬🇾" },
  { name: "Suriname", flag: "🇸🇷" }
];

console.log(`🌍 ${allCountries.length} countries loaded`);

// =============================================
// HEALTH CHECK
// =============================================
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    message: "VisaPass Backend is running on Deno Deploy! 🚀",
    database: "Supabase ✅",
    gemini: GEMINI_API_KEY ? "Configured ✅" : "Not configured",
    paystack: PAYSTACK_SECRET_KEY ? "Configured ✅" : "Not configured",
    firebase: FIREBASE_PROJECT_ID ? "Configured ✅" : "Not configured",
    countries: allCountries.length,
    timestamp: new Date()
  });
});

// =============================================
// GET: All countries
// =============================================
app.get("/api/countries", (req, res) => {
  res.json({
    success: true,
    count: allCountries.length,
    countries: allCountries
  });
});

// =============================================
// GET: Document requirements
// =============================================
app.get("/api/documents/:country", async (req, res) => {
  try {
    const countryName = decodeURIComponent(req.params.country);
    
    const { data, error } = await supabase
      .from("countries")
      .select("*")
      .eq("name", countryName)
      .single();
    
    if (data && !error) {
      return res.json({
        success: true,
        data: {
          country: data.name,
          flag: data.flag,
          documents: data.documents,
          total: data.documents ? data.documents.length : 0,
          lastUpdated: data.last_updated
        }
      });
    }
    
    const prompt = `
You are a visa document expert for ${countryName}.
Provide the official document requirements for tourist visa to ${countryName}.
Return ONLY this JSON:
{
  "documents": [
    {"name": "Document name", "required": true, "description": "Brief description"}
  ]
}
`;
    
    const geminiResponse = await callGemini(prompt);
    const parsed = JSON.parse(geminiResponse);
    const finalDocuments = parsed.documents || [];
    
    await supabase
      .from("countries")
      .upsert({
        name: countryName,
        flag: allCountries.find(c => c.name === countryName)?.flag || "🌍",
        documents: finalDocuments,
        last_updated: new Date()
      });
    
    res.json({
      success: true,
      data: {
        country: countryName,
        flag: allCountries.find(c => c.name === countryName)?.flag || "🌍",
        documents: finalDocuments,
        total: finalDocuments.length,
        lastUpdated: new Date()
      }
    });
    
  } catch (error) {
    if (error.message === "GEMINI_LIMIT_REACHED") {
      return res.status(503).json({
        success: false,
        error: "SERVICE_UNAVAILABLE",
        message: "Service at capacity. Try after 12:00 AM."
      });
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

// =============================================
// GENERATE COVER LETTER
// =============================================
app.post("/api/coverletter/generate", async (req, res) => {
  try {
    const formData = req.body;
    const userEmail = formData.email || req.headers["x-user-email"];
    
    if (!userEmail) {
      return res.status(400).json({
        success: false,
        error: "EMAIL_REQUIRED",
        message: "Please provide your email address.",
        requiresPayment: true
      });
    }
    
    const paymentCheck = await checkUserPayment(userEmail);
    
    if (!paymentCheck.hasPaid) {
      return res.status(402).json({
        success: false,
        error: "PAYMENT_REQUIRED",
        message: "💳 Please pay to access this feature.",
        requiresPayment: true,
        paymentLink: "/api/payments/initialize",
        data: {
          amount: 10000,
          purpose: "cover_letter",
          userEmail: userEmail
        }
      });
    }
    
    if (!isApiAvailable()) {
      return res.status(503).json({
        success: false,
        error: "SERVICE_UNAVAILABLE",
        message: "Service at capacity. Try later."
      });
    }
    
    const letter = await generatePowerfulCoverLetter(formData);
    
    await supabase
      .from("cover_letters")
      .insert({
        user_email: userEmail,
        user_name: formData.name || "User",
        country: formData.destination || "Unknown",
        content: letter,
        form_data: formData,
        payment_reference: paymentCheck.payment?.reference,
        created_at: new Date()
      });
    
    // Auto notification
    try {
      const user = await getUserByEmail(userEmail);
      const fcmToken = user?.fcmToken || null;
      const userId = user?.id || null;
      
      if (fcmToken) {
        await sendPushNotification(fcmToken, "📨 Cover Letter Ready!", `🎉 ${formData.name || "User"}, your powerful cover letter for ${formData.destination || "your visa"} is ready! Download now.`);
      }
      
      if (userId) {
        await saveNotification(userId, userEmail, "📨 Cover Letter Ready!", `Your cover letter for ${formData.destination || "your visa"} has been generated. Download and review it now!`, "cover_letter");
      }
    } catch (notifyError) {
      console.error("Notification error:", notifyError);
    }
    
    res.json({
      success: true,
      data: {
        letter: letter,
        generatedAt: new Date(),
        message: `✅ Hello ${formData.name || "User"}! Your cover letter is ready!`
      }
    });
    
  } catch (error) {
    if (error.message === "GEMINI_LIMIT_REACHED") {
      return res.status(503).json({
        success: false,
        error: "SERVICE_UNAVAILABLE",
        message: "Service at capacity. Try after 12:00 AM."
      });
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

// =============================================
// GENERATE POWERFUL COVER LETTER
// =============================================
async function generatePowerfulCoverLetter(formData) {
  const prompt = `
You are VisaPass AI — the world's best visa cover letter expert.

Country: ${formData.destination}

User Details:
- Name: ${formData.name || 'John Doe'}
- Nationality: ${formData.nationality || 'Nigerian'}
- Job: ${formData.job || 'Software Engineer'}
- Employer: ${formData.employer || 'ABC Technologies'}
- Salary: ${formData.salary || '₦500,000'}
- Purpose: ${formData.purpose || 'Tourism'}
- Travel Dates: ${formData.departure || '14 Feb 2025'} to ${formData.returnDate || '28 Feb 2025'}
- Travel History: ${formData.travelHistory || 'None'}
- Ties to Home: ${formData.ties || 'Job, Family, Property'}
- Sponsor: ${formData.sponsor || 'Myself'}
- Visa Type: ${formData.visaType || 'Tourist'}

Write a powerful cover letter that will make the embassy officer say "APPROVED!"
Return as a complete formal cover letter.
`;

  const response = await callGemini(prompt);
  return response;
}

// =============================================
// CHECK DOCUMENTS
// =============================================
app.post("/api/documents/check", async (req, res) => {
  try {
    const { country, documents, userName, userEmail } = req.body;
    
    if (!userEmail) {
      return res.status(400).json({
        success: false,
        error: "EMAIL_REQUIRED",
        message: "Please provide your email address.",
        requiresPayment: true
      });
    }
    
    const paymentCheck = await checkUserPayment(userEmail);
    
    if (!paymentCheck.hasPaid) {
      return res.status(402).json({
        success: false,
        error: "PAYMENT_REQUIRED",
        message: "💳 Please pay to access this feature.",
        requiresPayment: true,
        paymentLink: "/api/payments/initialize",
        data: {
          amount: 10000,
          purpose: "document_check",
          userEmail: userEmail
        }
      });
    }
    
    if (!isApiAvailable()) {
      return res.status(503).json({
        success: false,
        error: "SERVICE_UNAVAILABLE",
        message: "Service at capacity. Try later."
      });
    }
    
    const documentCheck = await checkUserDocuments(country, documents, userName);
    const fakeCheck = await detectFakeDocuments(documents, country, userName);
    
    const combinedResults = {
      documentCheck: documentCheck,
      fakeCheck: fakeCheck,
      overallStatus: {
        documentScore: documentCheck.summary?.score || "0%",
        riskLevel: fakeCheck.overallRisk || "LOW",
        ready: documentCheck.summary?.ready && fakeCheck.overallRisk !== "HIGH"
      }
    };
    
    await supabase
      .from("document_checks")
      .insert({
        user_email: userEmail,
        user_name: userName || "User",
        country: country,
        results: combinedResults,
        payment_reference: paymentCheck.payment?.reference,
        created_at: new Date()
      });
    
    // Auto notification
    try {
      const user = await getUserByEmail(userEmail);
      const fcmToken = user?.fcmToken || null;
      const userId = user?.id || null;
      
      const riskEmoji = fakeCheck.overallRisk === "HIGH" ? "⚠️" : "✅";
      const riskMessage = fakeCheck.overallRisk === "HIGH" 
        ? "Some documents need attention. Please review." 
        : "All documents look good!";
      
      if (fcmToken) {
        await sendPushNotification(fcmToken, "📄 Document Check Complete!", `${riskEmoji} ${userName || "User"}, your documents for ${country} have been checked. ${riskMessage}`);
      }
      
      if (userId) {
        await saveNotification(userId, userEmail, "📄 Document Check Complete!", `Your documents for ${country} have been checked. Score: ${documentCheck.summary?.score || "0%"}. ${riskMessage}`, "document_check");
      }
    } catch (notifyError) {
      console.error("Notification error:", notifyError);
    }
    
    res.json({
      success: true,
      data: combinedResults
    });
    
  } catch (error) {
    if (error.message === "GEMINI_LIMIT_REACHED") {
      return res.status(503).json({
        success: false,
        error: "SERVICE_UNAVAILABLE",
        message: "Service at capacity. Try after 12:00 AM."
      });
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

// =============================================
// DOCUMENT CHECKER
// =============================================
async function checkUserDocuments(country, documents, userName) {
  const prompt = `
You are a visa document expert for ${country} embassy.
User: ${userName || 'User'}
Documents: ${JSON.stringify(documents)}

Check each document:
1. IDENTIFY the document type
2. CHECK quality (clear, blurry, cropped)
3. CHECK completeness (all pages, all sections)
4. CHECK if it MEETS or EXCEEDS requirements
5. CHECK for any issues

Return in this format:
{
  "documents": [
    {
      "name": "Document name",
      "status": "✅ VALID" or "⚠️ ISSUE" or "❌ MISSING",
      "message": "Brief feedback"
    }
  ],
  "summary": {
    "total": 0,
    "valid": 0,
    "issues": 0,
    "missing": 0,
    "score": "0%",
    "ready": false
  }
}
`;

  const response = await callGemini(prompt);
  return JSON.parse(response);
}

// =============================================
// FAKE DOCUMENT DETECTION
// =============================================
async function detectFakeDocuments(documents, country, userName) {
  const prompt = `
You are a visa fraud detection expert for ${country} embassy.
User: ${userName || 'User'}
Documents uploaded: ${JSON.stringify(documents)}

Check for signs of being FAKE or EDITED.
Return in this format:
{
  "overallRisk": "HIGH" or "MEDIUM" or "LOW",
  "summary": "Summary of findings",
  "advice": "What user should do"
}
`;

  const response = await callGemini(prompt);
  return JSON.parse(response);
}

// =============================================
// FIREBASE: User Registration
// =============================================
app.post("/api/auth/register", async (req, res) => {
  try {
    const { email, password, name } = req.body;

    const userData = await firebaseRequest("accounts:signUp", {
      method: "POST",
      body: JSON.stringify({
        email: email,
        password: password,
        displayName: name || "User",
        returnSecureToken: true
      })
    });

    if (userData.error) {
      return res.status(400).json({
        success: false,
        error: userData.error.message || "Registration failed"
      });
    }

    // Save user to Firestore
    try {
      const accessToken = await getFirebaseAccessToken();
      await fetch(
        `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${userData.localId}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${accessToken}`
          },
          body: JSON.stringify({
            fields: {
              uid: { stringValue: userData.localId },
              email: { stringValue: email },
              name: { stringValue: name || "User" },
              createdAt: { timestampValue: new Date().toISOString() },
              role: { stringValue: "user" },
              lastLogin: { timestampValue: new Date().toISOString() }
            }
          })
        }
      );
    } catch (e) {
      console.error("Firestore save error:", e);
    }

    // Save to Supabase
    try {
      await supabaseRequest("user_applications", {
        method: "POST",
        body: JSON.stringify({
          user_id: userData.localId,
          user_email: email,
          user_name: name || "User",
          status: "pending",
          created_at: new Date().toISOString()
        })
      });
    } catch (e) {
      console.error("Supabase save error:", e);
    }

    res.json({
      success: true,
      data: {
        uid: userData.localId,
        email: userData.email,
        name: name || "User",
        idToken: userData.idToken,
        message: "✅ Registration successful! Welcome to VisaPass! 🎉"
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// =============================================
// FIREBASE: Save FCM Token
// =============================================
app.post("/api/auth/save-token", async (req, res) => {
  try {
    const { userId, fcmToken } = req.body;

    if (!userId || !fcmToken) {
      return res.status(400).json({
        success: false,
        error: "Missing userId or fcmToken"
      });
    }

    const accessToken = await getFirebaseAccessToken();
    await fetch(
      `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${userId}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${accessToken}`
        },
        body: JSON.stringify({
          fields: {
            fcmToken: { stringValue: fcmToken },
            updatedAt: { timestampValue: new Date().toISOString() }
          }
        })
      }
    );

    res.json({
      success: true,
      message: "✅ FCM token saved successfully!"
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// =============================================
// FIREBASE: Get User Notifications
// =============================================
app.get("/api/notifications/:userId", async (req, res) => {
  try {
    const { userId } = req.params;

    const accessToken = await getFirebaseAccessToken();
    const response = await fetch(
      `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/notifications?orderBy=createdAt desc&limit=50`,
      {
        headers: {
          "Authorization": `Bearer ${accessToken}`
        }
      }
    );
    const data = await response.json();

    const notifications = data.documents || [];
    const filtered = notifications
      .filter(doc => {
        const fields = doc.fields || {};
        return fields.userId?.stringValue === userId;
      })
      .map(doc => {
        const fields = doc.fields || {};
        return {
          id: doc.name.split("/").pop(),
          userId: fields.userId?.stringValue || "",
          email: fields.email?.stringValue || "",
          title: fields.title?.stringValue || "",
          body: fields.body?.stringValue || "",
          type: fields.type?.stringValue || "",
          read: fields.read?.booleanValue || false,
          createdAt: fields.createdAt?.timestampValue || new Date().toISOString()
        };
      });

    res.json({
      success: true,
      data: filtered
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// =============================================
// FIREBASE: Mark Notification as Read
// =============================================
app.put("/api/notifications/:id/read", async (req, res) => {
  try {
    const { id } = req.params;

    const accessToken = await getFirebaseAccessToken();
    await fetch(
      `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/notifications/${id}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${accessToken}`
        },
        body: JSON.stringify({
          fields: {
            read: { booleanValue: true },
            readAt: { timestampValue: new Date().toISOString() }
          }
        })
      }
    );

    res.json({
      success: true,
      message: "✅ Notification marked as read"
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// =============================================
// PAYSTACK INITIALIZE PAYMENT
// =============================================
app.post("/api/payments/initialize", async (req, res) => {
  try {
    const { userEmail, userName, purpose, amount = 10000 } = req.body;

    if (!userEmail) {
      return res.status(400).json({
        success: false,
        error: "Email required",
        message: "Please provide your email address"
      });
    }

    const paymentCheck = await checkUserPayment(userEmail);
    if (paymentCheck.hasPaid) {
      return res.json({
        success: true,
        alreadyPaid: true,
        data: {
          message: "✅ You already have an active payment! You can use all features.",
          payment: paymentCheck.payment
        }
      });
    }

    const paystackResponse = await fetch("https://api.paystack.co/transaction/initialize", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${PAYSTACK_SECRET_KEY}`
      },
      body: JSON.stringify({
        amount: amount * 100,
        email: userEmail,
        reference: `VP-${Date.now()}-${Math.random().toString(36).substring(7)}`,
        callback_url: `${FRONTEND_URL}/payment/verify`,
        metadata: {
          user_name: userName || "User",
          purpose: purpose || "visa_assistance",
          user_email: userEmail
        }
      })
    });

    const paystackData = await paystackResponse.json();

    if (!paystackData.status) {
      throw new Error(paystackData.message || "Paystack initialization failed");
    }

    await supabaseRequest("payments", {
      method: "POST",
      body: JSON.stringify({
        user_email: userEmail,
        user_name: userName || "User",
        amount: amount,
        purpose: purpose || "visa_assistance",
        reference: paystackData.data.reference,
        status: "pending",
        paystack_data: paystackData.data,
        created_at: new Date().toISOString()
      })
    });

    res.json({
      success: true,
      data: {
        authorizationUrl: paystackData.data.authorization_url,
        reference: paystackData.data.reference,
        amount: amount,
        message: "🔗 Redirecting to Paystack..."
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// =============================================
// PAYSTACK WEBHOOK
// =============================================
app.post("/api/payments/webhook", async (req, res) => {
  try {
    const hash = crypto.createHmac("sha512", PAYSTACK_SECRET_KEY)
      .update(JSON.stringify(req.body))
      .digest("hex");

    if (hash !== req.headers["x-paystack-signature"]) {
      return res.status(401).json({ error: "Invalid signature" });
    }

    const event = req.body;

    if (event.event === "charge.success") {
      const data = event.data;
      const reference = data.reference;
      const email = data.customer?.email;
      const userName = data.metadata?.user_name || "User";

      console.log(`✅ Payment successful for ${email}, reference: ${reference}`);

      await supabaseRequest(`payments?reference=eq.${reference}`, {
        method: "PATCH",
        body: JSON.stringify({
          status: "success",
          paid_at: new Date().toISOString(),
          paystack_data: data
        })
      });

      await supabaseRequest(`user_applications?user_email=eq.${email}`, {
        method: "PATCH",
        body: JSON.stringify({
          payment_status: "paid",
          payment_reference: reference,
          updated_at: new Date().toISOString()
        })
      });

      // Auto notification
      try {
        const user = await getUserByEmail(email);
        const fcmToken = user?.fcmToken || null;
        const userId = user?.id || null;
        
        if (fcmToken) {
          await sendPushNotification(fcmToken, "✅ Payment Successful!", `🎉 ${userName}, your payment was successful! You now have full access to all VisaPass features.`);
        }
        
        if (userId) {
          await saveNotification(userId, email, "✅ Payment Successful!", `🎉 ${userName}, your payment of ₦${(data.amount / 100).toLocaleString()} was successful! You now have full access to all features.`, "payment");
        }
      } catch (notifyError) {
        console.error("Notification error:", notifyError);
      }
    }

    res.status(200).json({ status: "Webhook received" });

  } catch (error) {
    console.error("Webhook error:", error);
    res.status(500).json({ error: "Webhook processing failed" });
  }
});

// =============================================
// ADMIN: Broadcast to All Users
// =============================================
app.post("/api/admin/broadcast", isAdmin, async (req, res) => {
  try {
    const { title, body, data } = req.body;

    if (!title || !body) {
      return res.status(400).json({
        success: false,
        error: "Missing title or body"
      });
    }

    const accessToken = await getFirebaseAccessToken();
    const response = await fetch(
      `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/users`,
      {
        headers: {
          "Authorization": `Bearer ${accessToken}`
        }
      }
    );
    const result = await response.json();
    const users = result.documents || [];

    let sentCount = 0;

    for (const doc of users) {
      const fields = doc.fields || {};
      const fcmToken = fields.fcmToken?.stringValue || null;
      const userId = doc.name.split("/").pop();

      if (fcmToken) {
        try {
          await sendPushNotification(fcmToken, title, body, data || {});
          sentCount++;
        } catch (e) {
          console.error("Failed to send to user:", userId);
        }
      }
    }

    res.json({
      success: true,
      data: {
        sentCount: sentCount,
        totalUsers: users.length,
        message: `✅ Broadcast sent to ${sentCount} users!`
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// =============================================
// ADMIN: Send Email
// =============================================
app.post("/api/admin/send-email", isAdmin, async (req, res) => {
  try {
    const { to, subject, body, userId } = req.body;

    if (!to || !subject || !body) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields"
      });
    }

    const accessToken = await getFirebaseAccessToken();
    await fetch(
      `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/emails`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${accessToken}`
        },
        body: JSON.stringify({
          fields: {
            to: { stringValue: to },
            subject: { stringValue: subject },
            body: { stringValue: body },
            userId: { stringValue: userId || "" },
            status: { stringValue: "pending" },
            createdAt: { timestampValue: new Date().toISOString() }
          }
        })
      }
    );

    res.json({
      success: true,
      message: "✅ Email queued for sending!"
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// =============================================
// ADMIN LOGIN PAGE
// =============================================
app.get("/admin-login", (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head><title>VisaPass Admin Login</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:Arial;background:#0a0e27;display:flex;justify-content:center;align-items:center;height:100vh}
.login-container{background:#1a1f3a;padding:40px;border-radius:16px;width:400px;border:1px solid #2a2f4a}
.login-container h1{color:#fff;text-align:center;margin-bottom:10px}
.login-container p{color:#888;text-align:center;margin-bottom:30px}
.login-container input{width:100%;padding:12px;margin-bottom:16px;border:1px solid #2a2f4a;border-radius:8px;background:#0a0e27;color:#fff;font-size:16px}
.login-container button{width:100%;padding:14px;background:#4f46e5;color:#fff;border:none;border-radius:8px;font-size:16px;cursor:pointer}
.login-container button:hover{background:#6366f1}
.error{color:#ef4444;text-align:center;margin-bottom:16px;display:none}
.success{color:#22c55e;text-align:center;margin-bottom:16px;display:none}
.shield{text-align:center;font-size:48px;margin-bottom:16px}
</style>
</head>
<body>
<div class="login-container">
<div class="shield">🛡️</div>
<h1>Admin Login</h1>
<p>🔐 Only authorized admins can enter</p>
<div class="error" id="errorMsg">❌ Invalid credentials</div>
<div class="success" id="successMsg">✅ Login successful! Redirecting...</div>
<input type="email" id="email" placeholder="admin@visapass.com" value="obinnafestus471@gmail.com">
<input type="password" id="password" placeholder="••••••••" value="VisaPassAdmin123">
<button onclick="login()">🔑 Enter Dashboard</button>
</div>
<script>
async function login(){const email=document.getElementById('email').value;const password=document.getElementById('password').value;const errorMsg=document.getElementById('errorMsg');const successMsg=document.getElementById('successMsg');errorMsg.style.display='none';successMsg.style.display='none';try{const response=await fetch('/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password})});const data=await response.json();if(data.success){successMsg.style.display='block';successMsg.textContent='✅ '+data.data.message;localStorage.setItem('adminToken',data.data.adminToken);localStorage.setItem('adminEmail',email);setTimeout(()=>{window.location.href='/admin-dashboard'},1500)}else{errorMsg.style.display='block';errorMsg.textContent='❌ '+data.message}}catch(error){errorMsg.style.display='block';errorMsg.textContent='❌ Connection error'}}
</script>
</body></html>`);
});

// =============================================
// ADMIN LOGIN API
// =============================================
app.post("/api/admin/login", async (req, res) => {
  const { email, password } = req.body;

  if (!ADMIN_EMAILS.includes(email) || password !== ADMIN_PASSWORD) {
    return res.status(401).json({
      success: false,
      message: "Invalid credentials"
    });
  }

  const adminToken = Buffer.from(`${email}:${Date.now()}`).toString("base64");

  res.json({
    success: true,
    data: {
      adminToken: adminToken,
      email: email,
      message: "✅ Welcome Admin!"
    }
  });
});

// =============================================
// ADMIN DASHBOARD
// =============================================
app.get("/admin-dashboard", (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head><title>VisaPass Admin</title>
<style>
body{font-family:Arial;background:#0a0e27;color:#fff;padding:40px}
h1{color:#4f46e5}
</style>
</head>
<body>
<h1>🛡️ VisaPass Admin Dashboard</h1>
<p>Welcome Admin! 👋</p>
<p>Your dashboard is loading...</p>
<script>
if(!localStorage.getItem('adminToken')){window.location.href='/admin-login'}
document.write('<p>✅ Logged in as: ' + localStorage.getItem('adminEmail') + '</p>');
</script>
</body>
</html>`);
});

// =============================================
// START SERVER (Deno way)
// =============================================
Deno.serve({ port: PORT }, app);

console.log(`
╔═════════════════════════════════════════════════════════════════╗
║                                                                 ║
║              ✅ VISAPASS BACKEND IS RUNNING!                     ║
║                                                                 ║
║  📡 API URL: http://localhost:${PORT}                           ║
║  🌍 Countries: ${allCountries.length} loaded                    ║
║  💾 Database: Supabase ✅                                       ║
║  🤖 Gemini: ${GEMINI_API_KEY ? '✅' : '❌'}                      ║
║  💳 Paystack: ${PAYSTACK_SECRET_KEY ? '✅' : '❌'}               ║
║  🔥 Firebase: ${FIREBASE_PROJECT_ID ? '✅' : '❌'}               ║
║  🛡️ Admin: /admin-login                                        ║
║  ☁️ Deno Deploy: ✅                                             ║
║                                                                 ║
║  ✅ Payment Required Before Features                           ║
║  ✅ Paystack Webhook Active                                    ║
║  ✅ Auto Payment Confirmation                                  ║
║  ✅ Admin Dashboard Ready                                      ║
║  ✅ 130 Countries Loaded                                       ║
║  ✅ Auto Notifications                                         ║
║                                                                 ║
╚═════════════════════════════════════════════════════════════════╝
`);
