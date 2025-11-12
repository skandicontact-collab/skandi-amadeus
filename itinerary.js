export async function generateItineraryPdf({ flightBooking, hotelBooking, passengers, leadPassenger }) {
  const PDFDocument = (await import("pdfkit")).default;
  const doc = new PDFDocument();
  const chunks = [];
  doc.on("data", (chunk) => chunks.push(chunk));
  doc.on("end", () => {});
  doc.fontSize(20).text("SKANDI Travels – Booking Confirmation", { align: "center" });
  doc.text(`PNR: ${flightBooking?.pnr || "TBD"}`);
  doc.text(`Lead Passenger: ${leadPassenger?.firstName || ""} ${leadPassenger?.lastName || ""}`);
  doc.text("\nFlight Segments:");
  (flightBooking?.segments || []).forEach((s) =>
    doc.text(`${s.origin} → ${s.destination}  ${s.flightNumber}`)
  );
  doc.end();
  return Buffer.concat(chunks);
}