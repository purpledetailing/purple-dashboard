import { NextResponse } from "next/server";

export const runtime = "nodejs"; // important for file uploads
export const dynamic = "force-dynamic";

const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SERVICE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const BUCKET = "vehicle-photos";

function normalizeVin(raw: string) {
  return (raw || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}
function isValidVin(vin: string) {
  return /^[A-HJ-NPR-Z0-9]{17}$/.test(vin);
}

async function sbInsertVehiclePhotos(rows: any[]) {
  const url = `${SUPABASE_URL}/rest/v1/vehicle_photos`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error(`vehicle_photos insert failed: ${r.status} ${await r.text()}`);
}

async function storageUpload(path: string, file: File) {
  const url = `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": file.type || "application/octet-stream",
      "x-upsert": "true",
    },
    body: await file.arrayBuffer(),
  });
  if (!r.ok) throw new Error(`storage upload failed: ${r.status} ${await r.text()}`);
}

export async function POST(req: Request) {
  try {
    if (!SUPABASE_URL || !SERVICE_KEY) {
      return NextResponse.json({ error: "Server not configured (missing Supabase env vars)." }, { status: 500 });
    }

    const form = await req.formData();
    const vinRaw = String(form.get("vin") || "");
    const vin = normalizeVin(vinRaw);

    if (!isValidVin(vin)) {
      return NextResponse.json({ error: "Invalid VIN." }, { status: 400 });
    }

    const files = form.getAll("photos").filter(Boolean) as File[];
    if (!files.length) {
      return NextResponse.json({ error: "No files received." }, { status: 400 });
    }
    if (files.length > 8) {
      return NextResponse.json({ error: "Max 8 photos per upload." }, { status: 400 });
    }

    // create a batch id (uuid v4) without needing a library
    const batchId = crypto.randomUUID();

    // upload + DB rows
    const rows: any[] = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const ext = (file.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "");
      const safeExt = ext.length > 8 ? "jpg" : ext;

      // store path: VIN/batch_id/000.jpg
      const filename = `${String(i + 1).padStart(3, "0")}.${safeExt}`;
      const path = `${vin}/${batchId}/${filename}`;

      await storageUpload(path, file);

      rows.push({
        vin,
        batch_id: batchId,
        storage_path: path,
        original_filename: file.name,
        content_type: file.type || null,
        bytes: file.size || null,
        sort_order: i,
      });
    }

    await sbInsertVehiclePhotos(rows);

    return NextResponse.json({ ok: true, vin, batch_id: batchId, count: rows.length });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Upload failed." }, { status: 500 });
  }
}
