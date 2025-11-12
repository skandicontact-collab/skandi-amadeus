import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
import nodemailer from "nodemailer";
import PDFDocument from "pdfkit";
import bodyParser from "body-parser";
import Stripe from "stripe";
import fs from "fs";
import path from "path";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(bodyParser.urlencoded({ extended: true }));

// -----------------------------
// ENVIRONMENT VARIABLES
// -----------------------------
const {
  PORT,
  AMADEUS_CLIENT_ID,
  AMADEUS_CLIENT_SECRET,
  AMADEUS_ENV,
  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASS,
  EMAIL_FROM,
  STRIPE_SECRET_KEY,
} = process.env;

const stripe = new Stripe(STRIPE_SECRET_KEY);
const AMADEUS_BASE =
  AMADEUS_ENV === "production"
    ? "https://api.amadeus.com"
    : "https://test.api.amadeus.com";

// -----------------------------
// AMADEUS TOKEN HANDLER
// -----------------------------
let amadeusToken = null;
async function getAmadeusToken() {
  if (amadeusToken) return amadeusToken;
  const res = await fetch(`${AMADEUS_BASE}/v1/security/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: AMADEUS_CLIENT_ID,
      client_secret: AMADEUS_CLIENT_SECRET,
    }),
  });
  const data = await res.json();
  amadeusToken = data.access_token;
  setTimeout(() => (amadeusToken = null), 14 * 60 * 1000); // refresh every 14 min
  return amadeusToken;
}

// -----------------------------
// FLIGHT SEARCH
// -----------------------------
app.post("/api/amadeus/flights/search", async (req, res) => {
  try {
    const token = await getAmadeusToken();
    const { origin, destination, departureDate, returnDate, adults } = req.body;

    const url = `${AMADEUS_BASE}/v2/shopping/flight-offers?originLocationCode=${origin}&destinationLocationCode=${destination}&departureDate=${departureDate}&returnDate=${returnDate}&adults=${adults}&nonStop=false&max=10&currencyCode=USD`;

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await response.json();
    res.json(data.data || []);
  } catch (err) {
    console.error("Flight search error:", err);
    res.status(500).json({ error: "Flight search failed" });
  }
});

// -----------------------------
// HOTEL SEARCH
// -----------------------------
app.post("/api/amadeus/hotels/search", async (req, res) => {
  try {
    const token = await getAmadeusToken();
    const { cityCode, checkInDate, checkOutDate, adults } = req.body;

    const url = `${AMADEUS_BASE}/v1/reference-data/locations/hotels/by-city?cityCode=${cityCode}&adults=${adults}&checkInDate=${checkInDate}&checkOutDate=${checkOutDate}`;

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await response.json();
    res.json(data.data || []);
  } catch (err) {
    console.error("Hotel search error:", err);
    res.status(500).json({ error: "Hotel search failed" });
  }
});

// -----------------------------
// CHARTER MOCK SEARCH
// -----------------------------
app.post("/api/charter/search", (req, res) => {
  const { origin, destination, departureDate, returnDate } = req.body;
  const dummy = [
    {
      id: "SKD001",
      origin,
      destination,
      departureDate,
      returnDate,
      aircraft: "Boeing 737-800",
      seats: 186,
      price: 4800,
      airline: "SKANDI Charter",
    },
  ];
  res.json(dummy);
});

// -----------------------------
// STRIPE CHECKOUT
// -----------------------------
app.post("/api/stripe/checkout", async (req, res) => {
  try {
    const { totalPrice, passengerInfo, flightDetails } = req.body;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: `SKANDI Booking: ${flightDetails?.origin} → ${flightDetails?.destination}`,
            },
            unit_amount: Math.round(totalPrice * 100),
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      success_url: "https://skandigroup.wixstudio.com/confirmation?status=success",
      cancel_url: "https://skandigroup.wixstudio.com/booking?status=cancelled",
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("Stripe checkout error:", err);
    res.status(500).json({ error: "Payment failed" });
  }
});

// -----------------------------
// PDF ITINERARY GENERATOR
// -----------------------------
app.post("/api/pdf/itinerary", async (req, res) => {
  try {
    const { name, flight, price } = req.body;
    const doc = new PDFDocument();
    const filename = `itinerary_${Date.now()}.pdf`;
    const filepath = path.join("public", filename);
    doc.pipe(fs.createWriteStream(filepath));

    doc.fontSize(22).text("SKANDI Travels Itinerary", { align: "center" });
    doc.moveDown();
    doc.fontSize(14).text(`Passenger: ${name}`);
    doc.text(`Route: ${flight.origin} → ${flight.destination}`);
    doc.text(`Departure: ${flight.departureDate}`);
    doc.text(`Return: ${flight.returnDate}`);
    doc.text(`Price: $${price} USD`);
    doc.moveDown();
    doc.text("Thank you for booking with SKANDI Travels!");
    doc.end();

    res.json({ url: `https://skandi-amadeus.onrender.com/${filename}` });
  } catch (err) {
    console.error("PDF creation error:", err);
    res.status(500).json({ error: "Could not generate PDF" });
  }
});

// -----------------------------
// EMAIL CONFIRMATION
// -----------------------------
app.post("/api/email/confirmation", async (req, res) => {
  try {
    const { email, name, itineraryUrl } = req.body;
    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: false,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });

    await transporter.sendMail({
      from: EMAIL_FROM,
      to: email,
      subject: "Your SKANDI Travels Booking Confirmation",
      html: `<h2>Hello ${name},</h2>
      <p>Thank you for booking with SKANDI Travels.</p>
      <p>Your itinerary is available here:</p>
      <a href="${itineraryUrl}">${itineraryUrl}</a>`,
    });

    res.json({ success: true });
  } catch (err) {
    console.error("Email error:", err);
    res.status(500).json({ error: "Email failed" });
  }
});

// -----------------------------
app.listen(PORT || 4000, () =>
  console.log(`SKANDI Amadeus server running on http://localhost:${PORT || 4000}`)
);
