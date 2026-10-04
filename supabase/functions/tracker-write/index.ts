const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const excelBackupRelay =
  "https://script.google.com/macros/s/AKfycbwi_9kPwUv1lrUzOlgNBUix00uaIBIbsb-ar-3IZRgkKPn4ebVVmsSypOu2FhgA4w_TuA/exec";

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function buildExcelPayload(data: Record<string, unknown>, author: string) {
  const hotels = Array.isArray(data.hotels) ? data.hotels : [];
  const vendors = Array.isArray(data.vendors) ? data.vendors : [];
  const guests: Record<string, unknown>[] = [];
  const rooms: Record<string, unknown>[] = [];
  let cellsConsidered = 0;

  for (const value of hotels) {
    if (!value || typeof value !== "object") continue;
    const hotel = value as Record<string, unknown>;
    const nights = Array.isArray(hotel.nights) ? hotel.nights : [];
    const grid = Array.isArray(hotel.grid) ? hotel.grid : [];
    grid.forEach((row, roomIndex) => {
      if (!Array.isArray(row)) return;
      row.forEach((cell, nightIndex) => {
        if (!Array.isArray(cell)) return;
        cell.forEach((name, slotIndex) => {
          cellsConsidered++;
          guests.push({
            hotel: hotel.name,
            room: roomIndex + 1,
            night: nights[nightIndex],
            slot: slotIndex + 1,
            name: String(name ?? "").trim(),
          });
        });
      });
    });
    rooms.push({
      hotel: hotel.name,
      roomsBooked: hotel.roomsBooked ?? hotel.totalRooms,
      roomNos: Array.isArray(hotel.roomNos) ? hotel.roomNos : [],
    });
  }

  const vendorRows = vendors.map(value => {
    const vendor = value && typeof value === "object"
      ? value as Record<string, unknown> : {};
    return {
      name: vendor.name ?? "",
      contact: vendor.contact ?? "",
      phone: vendor.phone ?? "",
      whatsapp: vendor.whatsapp ?? "",
      event: vendor.event ?? "",
      eventDate: vendor.eventDate ?? "",
      quoted: vendor.quoted ?? "",
      paid: vendor.paid ?? "",
      paymentMode: vendor.paymentMode ?? "",
      ref: vendor.ref ?? "",
      paidOn: vendor.paidOn ?? "",
      address: vendor.address ?? "",
      notes: vendor.notes ?? "",
      row: vendor.row ?? null,
      isNew: !!vendor.isNew,
    };
  });
  const quoted = vendorRows.reduce((sum, vendor) =>
    sum + (Number(vendor.quoted) || 0), 0);
  const paid = vendorRows.reduce((sum, vendor) =>
    sum + (Number(vendor.paid) || 0), 0);

  return {
    v: 2,
    mode: "full",
    event: data.event ?? "",
    sentAt: new Date().toISOString(),
    source: "supabase-realtime",
    author,
    baselineGenerated: data.generated ?? null,
    guests,
    rooms,
    vendors: vendorRows,
    totals: { quoted, paid, outstanding: quoted - paid },
    stats: { cellsConsidered, guestsSent: guests.length, hotelsSent: rooms.length },
  };
}

async function backupExcel(data: Record<string, unknown>, author: string) {
  const payload = buildExcelPayload(data, author);
  const response = await fetch(excelBackupRelay, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=UTF-8" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`Excel relay returned HTTP ${response.status}`);
  const result = await response.json();
  if (result.ok !== true) throw new Error("Excel relay did not accept the backup");
  console.info("Excel backup queued", result.path);
}

function scheduleExcelBackup(data: Record<string, unknown>, author: string) {
  EdgeRuntime.waitUntil(
    backupExcel(data, author).catch(error => {
      console.error("Excel background backup failed", error);
    }),
  );
}

Deno.serve(async request => {
  if (request.method === "OPTIONS")
    return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return reply({ error: "Method not allowed" }, 405);

  const expectedPassword = Deno.env.get("TRACKER_WRITE_PASSWORD");
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!expectedPassword || !url || !serviceKey)
    return reply({ error: "Server is not configured" }, 500);

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return reply({ error: "Invalid JSON body" }, 400);
  }
  if (typeof body.password !== "string" || body.password !== expectedPassword)
    return reply({ error: "Wrong password" }, 401);

  let rpc: string;
  let args: Record<string, unknown>;
  let author = "Anonymous";
  if (body.action === "initialize") {
    if (!body.data || typeof body.data !== "object" || Array.isArray(body.data))
      return reply({ error: "Invalid initial tracker data" }, 400);
    rpc = "initialize_tracker_state";
    args = { p_data: body.data };
  } else if (body.action === "patch") {
    const patches = body.patches;
    if (!Array.isArray(patches) || patches.length === 0 || patches.length > 1000
        || patches.some(p => !p || !Array.isArray(p.path) || p.path.length === 0
          || p.path.length > 32 || !p.path.every(
            (part: unknown) => typeof part === "string" && part.length <= 100)
          || !Object.hasOwn(p, "value")))
      return reply({ error: "Invalid tracker changes" }, 400);
    rpc = "apply_tracker_patches";
    args = { p_patches: patches };
    if (typeof body.author === "string" && body.author.trim())
      author = body.author.trim().slice(0, 100);
  } else {
    return reply({ error: "Unsupported action" }, 400);
  }

  const response = await fetch(`${url}/rest/v1/rpc/${rpc}`, {
    method: "POST",
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });
  if (!response.ok)
    return reply({ error: "Could not save shared tracker changes" }, 500);
  const data = await response.json() as Record<string, unknown>;
  scheduleExcelBackup(data, author);
  return reply({ data, backupQueued: true });
});
