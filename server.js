console.log("Booting SKANDI server...");

import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import nodemailer from "nodemailer";
import PDFDocument from "pdfkit";
import fetch from "node-fetch";
import Stripe from "stripe";
import { generateItineraryPdf } from "./templates/itinerary.js";

dotenv.config();
const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(cors());
app.use(express.static("public"));
const PORT = process.env.PORT || 4000;

const STRIPE = new Stripe(process.env.STRIPE_SECRET_KEY);
const AMADEUS_BASE =
  process.env.AMADEUS_ENV === "production"
    ? "https://api.amadeus.com"
    : "https://test.api.amadeus.com";

// TOKEN CACHE
let tokenCache = { access_token: null, expires_at: 0 };
async function getToken() {
  const now = Date.now();
  if (tokenCache.access_token && now < tokenCache.expires_at - 60000)
    return tokenCache.access_token;

  const params = new URLSearchParams();
  params.set("grant_type", "client_credentials");
  params.set("client_id", process.env.AMADEUS_CLIENT_ID);
  params.set("client_secret", process.env.AMADEUS_CLIENT_SECRET);

  const res = await fetch(`${AMADEUS_BASE}/v1/security/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString()
  });
  const data = await res.json();
  tokenCache = {
    access_token: data.access_token,
    expires_at: Date.now() + data.expires_in * 1000
  };
  return data.access_token;
}

// SMTP
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT),
  secure: process.env.SMTP_SECURE === "true",
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

// ========================= FLIGHT SEARCH =========================
app.post("/api/amadeus/flights/search", async (req, res) => {
  try {
    const token = await getToken();
    const p = req.body;
    const params = new URLSearchParams({
      originLocationCode: p.origin,
      destinationLocationCode: p.destination,
      departureDate: p.departureDate,
      adults: p.adults || 1,
      max: "10"
    });
    if (p.returnDate) params.set("returnDate", p.returnDate);

    const amadeusRes = await fetch(
      `${AMADEUS_BASE}/v2/shopping/flight-offers?${params}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const data = await amadeusRes.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ========================= HOTEL SEARCH =========================
app.post("/api/amadeus/hotels/search", async (req, res) => {
  try {
    const token = await getToken();
    const { cityCode, checkInDate, checkOutDate } = req.body;
    const params = new URLSearchParams({
      cityCode,
      checkInDate,
      checkOutDate,
      adults: "2"
    });
    const amadeusRes = await fetch(
      `${AMADEUS_BASE}/v2/shopping/hotel-offers?${params}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const data = await amadeusRes.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ========================= STRIPE CHECKOUT =========================
app.post("/api/stripe/checkout", async (req, res) => {
  try {
    const session = await STRIPE.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      line_items: req.body.items.map(item => ({
        price_data: {
          currency: "usd",
          product_data: { name: item.name },
          unit_amount: Math.round(item.price * 100)
        },
        quantity: item.quantity
      })),
      success_url: `${req.headers.origin}/success.html`,
      cancel_url: `${req.headers.origin}/cancel.html`
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========================= EMAIL / PDF =========================
app.post("/api/email/itinerary", async (req, res) => {
  try {
    const { to, booking } = req.body;
    const pdf = await generateItineraryPdf(booking);

    await transporter.sendMail({
      from: process.env.EMAIL_FROM,
      to,
      subject: `Your SKANDI Travels Itinerary`,
      text: "Attached is your itinerary.",
      attachments: [{ filename: "itinerary.pdf", content: pdf }]
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// === LIVE HOTEL & ACTIVITY CARDS FOR SKANDI FRONTEND ===
import fetch from "node-fetch";

// Reuse your Amadeus credentials
let accessToken = null;
let tokenExpiry = 0;

async function refreshAmadeusToken() {
  const now = Date.now();
  if (accessToken && now < tokenExpiry) return accessToken;

  const res = await fetch("https://test.api.amadeus.com/v1/security/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: process.env.AMADEUS_CLIENT_ID,
      client_secret: process.env.AMADEUS_CLIENT_SECRET
    })
  });
  const data = await res.json();
  accessToken = data.access_token;
  tokenExpiry = now + data.expires_in * 1000 - 60000;
  return accessToken;
}

// ✅ Fetch live hotels
app.get("/api/amadeus/hotels", async (req, res) => {
  try {
    const token = await refreshAmadeusToken();
    const city = req.query.city || "ATH";
    const response = await fetch(`https://test.api.amadeus.com/v3/shopping/hotel-offers?cityCode=${city}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await response.json();
    res.json(data.data || []);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load hotels" });
  }
});

// ✅ Fetch excursions / activities
app.get("/api/amadeus/activities", async (req, res) => {
  try {
    const token = await refreshAmadeusToken();
    const lat = req.query.lat || "37.9838"; // Athens default
    const lon = req.query.lon || "23.7275";
    const response = await fetch(`https://test.api.amadeus.com/v1/shopping/activities?latitude=${lat}&longitude=${lon}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await response.json();
    res.json(data.data || []);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load activities" });
  }
});

// ✅ Fetch destination inspiration
app.get("/api/amadeus/destinations", async (req, res) => {
  try {
    const token = await refreshAmadeusToken();
    const origin = req.query.origin || "ARN";
    const response = await fetch(`https://test.api.amadeus.com/v1/travel/recommendations?originLocationCode=${origin}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await response.json();
    res.json(data.data || []);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load destinations" });
  }
});

app.listen(PORT, () =>
  console.log(`✅ SKANDI Amadeus server running on http://localhost:${PORT}`)
);
