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

app.listen(PORT, () =>
  console.log(`✅ SKANDI Amadeus server running on http://localhost:${PORT}`)
);