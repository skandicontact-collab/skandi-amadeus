// ===========================================
// SKANDI Amadeus Server
// ===========================================

console.log("Booting SKANDI server...");

import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import nodemailer from "nodemailer";
import { generateItineraryPdf } from "./templates/itinerary.js";

dotenv.config();

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(cors());
app.use(express.static("public"));

const PORT = process.env.PORT || 4000;

// ===========================================
// AMADEUS CONFIGURATION
// ===========================================
const AMADEUS_CLIENT_ID = process.env.AMADEUS_CLIENT_ID;
const AMADEUS_CLIENT_SECRET = process.env.AMADEUS_CLIENT_SECRET;
const AMADEUS_ENV = process.env.AMADEUS_ENV || "test";

const AMADEUS_BASE =
  AMADEUS_ENV === "production"
    ? "https://api.amadeus.com"
    : "https://test.api.amadeus.com";

let tokenCache = {
  access_token: null,
  expires_at: 0,
};

// ===========================================
// FETCH ACCESS TOKEN
// ===========================================
async function getAccessToken() {
  const now = Date.now();
  if (tokenCache.access_token && now < tokenCache.expires_at - 60000) {
    return tokenCache.access_token;
  }
  const params = new URLSearchParams();
  params.set("grant_type", "client_credentials");
  params.set("client_id", AMADEUS_CLIENT_ID);
  params.set("client_secret", AMADEUS_CLIENT_SECRET);

  const res = await fetch(`${AMADEUS_BASE}/v1/security/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("Token error:", text);
    throw new Error(`Amadeus token error ${res.status}`);
  }

  const data = await res.json();
  tokenCache.access_token = data.access_token;
  tokenCache.expires_at = Date.now() + data.expires_in * 1000;
  return tokenCache.access_token;
}

// ===========================================
// SMTP / EMAIL CONFIGURATION
// ===========================================
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: process.env.SMTP_SECURE === "true",
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// ===========================================
// HELPER FUNCTIONS
// ===========================================
function buildAmadeusTravelers(frontendPassengers) {
  return frontendPassengers.map((p, idx) => ({
    id: String(idx + 1),
    dateOfBirth: p.dob || "1990-01-01",
    gender: p.gender || "UNSPECIFIED",
    name: {
      firstName: (p.firstName || "").toUpperCase(),
      lastName: (p.lastName || "").toUpperCase(),
    },
    contact: p.email ? { emailAddress: p.email } : undefined,
    documents: [
      {
        documentType: "PASSPORT",
        number: p.passportNumber || "TBD",
        expiryDate: p.passportExpiry || "2030-01-01",
        nationality: p.nationality || "US",
        holder: true,
        issuanceCountry: p.passportCountry || p.nationality || "US",
      },
    ],
  }));
}

function buildSsrRemarks(frontendPassengers) {
  const lines = [];
  frontendPassengers.forEach((p, idx) => {
    if (Array.isArray(p.ssrs) && p.ssrs.length) {
      const paxLabel = `${(p.firstName || "").toUpperCase()} ${(p.lastName || "").toUpperCase()}`;
      const codes = p.ssrs.join(", ");
      lines.push(`SSR for PAX ${idx + 1} (${paxLabel}): ${codes}`);
    }
  });
  return lines;
}

function buildSeatRemarks(seatSelections) {
  if (!Array.isArray(seatSelections)) return [];
  return seatSelections.map(
    (s) => `Seat selection: PAX ${s.travelerId} – Segment ${s.segmentIndex} – Seat ${s.seatNumber}`
  );
}

// ===========================================
// ROUTES: FLIGHT SEARCH
// ===========================================
app.post("/api/amadeus/flights/search", async (req, res) => {
  try {
    const token = await getAccessToken();
    const {
      originLocationCode,
      destinationLocationCode,
      departureDate,
      returnDate,
      adults,
      children,
      infants,
      travelClass,
      currencyCode,
    } = req.body;

    const params = new URLSearchParams();
    params.set("originLocationCode", originLocationCode);
    params.set("destinationLocationCode", destinationLocationCode);
    params.set("departureDate", departureDate);
    if (returnDate) params.set("returnDate", returnDate);
    params.set("adults", adults || 1);
    if (children && Number(children) > 0) params.set("children", children);
    if (infants && Number(infants) > 0) params.set("infants", infants);
    if (travelClass) params.set("travelClass", travelClass);
    if (currencyCode) params.set("currencyCode", currencyCode);
    params.set("max", "20");

    const amadeusRes = await fetch(
      `${AMADEUS_BASE}/v2/shopping/flight-offers?${params.toString()}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const data = await amadeusRes.json();
    if (!amadeusRes.ok) {
      console.error("Flight search error:", data);
      return res.status(amadeusRes.status).json(data);
    }

    const normalizedOffers = (data.data || []).map((offer) => {
      const it = offer.itineraries?.[0];
      const seg = it?.segments?.[0];
      const lastSeg = it?.segments?.[it.segments.length - 1];
      return {
        id: offer.id,
        raw: offer,
        price: {
          currency: offer.price?.currency,
          total: offer.price?.grandTotal || offer.price?.total,
        },
        cabin:
          offer.travelerPricings?.[0]?.fareDetailsBySegment?.[0]?.cabin ||
          travelClass,
        itineraries: offer.itineraries,
        segments: [
          {
            origin: seg?.departure?.iataCode,
            destination: lastSeg?.arrival?.iataCode,
            depTime: seg?.departure?.at,
            arrTime: lastSeg?.arrival?.at,
            carrier: seg?.carrierCode,
            operatingCarrier: seg?.operating?.carrierCode,
            flightNumber: `${seg?.carrierCode}${seg?.number}`,
          },
        ],
      };
    });

    res.json({ flightOffers: normalizedOffers, raw: data });
  } catch (err) {
    console.error("Flight search exception:", err);
    res.status(500).json({ error: "Server error on flight search" });
  }
});

// ===========================================
// ROUTES: HOTEL SEARCH
// ===========================================
app.post("/api/amadeus/hotels/search", async (req, res) => {
  try {
    const token = await getAccessToken();
    const { cityCode, checkInDate, checkOutDate, adults, roomQuantity, currencyCode } = req.body;

    const params = new URLSearchParams();
    params.set("cityCode", cityCode);
    params.set("checkInDate", checkInDate);
    params.set("checkOutDate", checkOutDate);
    params.set("adults", adults || 2);
    if (roomQuantity) params.set("roomQuantity", roomQuantity);
    if (currencyCode) params.set("currency", currencyCode);
    params.set("bestRateOnly", "true");

    const amadeusRes = await fetch(
      `${AMADEUS_BASE}/v2/shopping/hotel-offers?${params.toString()}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const data = await amadeusRes.json();
    if (!amadeusRes.ok) {
      console.error("Hotel search error:", data);
      return res.status(amadeusRes.status).json(data);
    }

    const normalized = (data.data || []).map((h) => {
      const offer = h.offers?.[0];
      return {
        hotelId: h.hotel?.hotelId,
        name: h.hotel?.name,
        cityCode: h.hotel?.cityCode,
        address: h.hotel?.address,
        offerId: offer?.id,
        price: {
          currency: offer?.price?.currency,
          total: offer?.price?.total,
        },
        checkInDate: offer?.checkInDate,
        checkOutDate: offer?.checkOutDate,
        room: offer?.room,
        boardType: offer?.boardType,
        raw: h,
      };
    });

    res.json({ hotels: normalized, raw: data });
  } catch (err) {
    console.error("Hotel search exception:", err);
    res.status(500).json({ error: "Server error on hotel search" });
  }
});

// ===========================================
// ROOT ROUTE
// ===========================================
app.get("/", (req, res) => {
  res.send("SKANDI Amadeus API is running ✅");
});

// ===========================================
// START SERVER
// ===========================================
app.listen(PORT, () => {
  console.log(`SKANDI Amadeus server running on http://localhost:${PORT}`);
});