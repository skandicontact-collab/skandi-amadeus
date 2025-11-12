import PDFDocument from "pdfkit";

export async function generateItineraryPdf(booking) {
  const doc = new PDFDocument({ margin: 50 });
  const chunks = [];
  doc.on("data", c => chunks.push(c));
  doc.on("end", () => {});

  doc.fontSize(18).fillColor("#022e64").text("SKANDI Travels – Flight Confirmation", { align: "center" });
  doc.moveDown();
  doc.fontSize(12).fillColor("#000").text(`Booking Reference: ${booking.pnr || "Pending"}`);
  doc.text(`Passenger: ${booking.passengerName || "N/A"}`);
  doc.text(`Email: ${booking.email || "N/A"}`);
  doc.moveDown();

  booking.segments?.forEach(seg => {
    doc.text(`${seg.origin} ➜ ${seg.destination}`);
    doc.text(`Flight: ${seg.flightNumber} (${seg.carrier})`);
    doc.text(`Departure: ${seg.depTime}`);
    doc.text(`Arrival: ${seg.arrTime}`);
    doc.moveDown();
  });

  doc.text("Thank you for choosing SKANDI Travels.", { align: "center" });
  doc.end();
  return Buffer.concat(chunks);
}