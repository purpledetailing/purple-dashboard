import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---- ENV ----
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// ---- STORAGE ----
const BUCKET = "vehicle_photos";

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error("❌ Missing Supabase env vars");
}

// ---- HELPERS ----
function normalizeVin(raw: string) {
  return (raw || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function isValidVin(vin: string) {
  return /^[A-HJ-NPR-Z0-9]{17}$/.test(vin);
}

// ---- HANDLER ----
export async function POST(req: NextRequest) {
  try {
    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      return NextResponse.json(
        { error: "Missing env vars" },
        { status: 500 }
      );
    }

    const supabase = createClient(
      SUPABASE_URL,
      SERVICE_ROLE_KEY,
      { auth: { persistSession: false } }
    );

    const form = await req.formData();
    const vinRaw = String(form.get("vin") || "");
    const vin = normalizeVin(vinRaw);

    if (!isValidVin(vin)) {
      return NextResponse.json(
        { error: "Invalid VIN" },
        { status: 400 }
      );
    }

    const files = form.getAll("photos") as File[];

    if (!files.length) {
      return NextResponse.json(
        { error: "No photos uploaded" },
        { status: 400 }
      );
    }

    let uploaded = 0;

    for (const file of files.slice(0, 8)) {
      const buffer = Buffer.from(await file.arrayBuffer());
      const ext = file.name.split(".").pop() || "jpg";
      const id = crypto.randomUUID();

      const path = `${vin}/${Date.now()}-${id}.${ext}`;

      const { error } = await supabase.storage
        .from(BUCKET)
        .upload(path, buffer, {
          contentType: file.type || "image/jpeg",
          upsert: false,
        });

      if (!error) uploaded++;
    }

    return NextResponse.json({
      success: true,
      vin,
      count: uploaded,
    });
  } catch (err: any) {
    console.error("❌ Upload error:", err);
    return NextResponse.json(
      { error: "Upload failed" },
      { status: 500 }
    );
  }
}
