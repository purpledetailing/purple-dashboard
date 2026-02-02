import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const BUCKET = process.env.SUPABASE_PHOTO_BUCKET || "vehicle-photos";

function normalizeVin(raw: string) {
  return (raw || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}
function isValidVin(vin: string) {
  return /^[A-HJ-NPR-Z0-9]{17}$/.test(vin);
}

export async function POST(req: Request) {
  try {
    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      return NextResponse.json(
        { error: "Missing env vars: NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" },
        { status: 500 }
      );
    }

    const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    const form = await req.formData();
    const vin = normalizeVin(String(form.get("vin") || ""));

    if (!isValidVin(vin)) {
      return NextResponse.json({ error: "Invalid VIN." }, { status: 400 });
    }

    const photos = form.getAll("photos") as File[];
    if (!photos || photos.length === 0) {
      return NextResponse.json({ error: "No photos received." }, { status: 400 });
    }
    if (photos.length > 8) {
      return NextResponse.json({ error: "Max 8 photos per upload." }, { status: 400 });
    }

    const uploadedPaths: string[] = [];

    for (const file of photos) {
      const arrayBuffer = await file.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);

      const mime = file.type || "image/jpeg";
      const ext =
        mime.includes("png") ? "png" :
        mime.includes("webp") ? "webp" :
        mime.includes("heic") ? "heic" :
        "jpg";

      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const safeName = (file.name || `photo.${ext}`).replace(/[^a-zA-Z0-9._-]/g, "_");
      const path = `${vin}/${stamp}_${safeName}`;

      const up = await supabaseAdmin.storage.from(BUCKET).upload(path, bytes, {
        contentType: mime,
        upsert: false,
      });

      if (up.error) {
        return NextResponse.json({ error: `Storage upload failed: ${up.error.message}` }, { status: 500 });
      }

      uploadedPaths.push(path);

      // ✅ This is why your dashboard table was empty
      const ins = await supabaseAdmin.from("vehicle_photos").insert({
        vin,
        storage_bucket: BUCKET,
        storage_path: path,
        original_name: file.name || null,
        mime_type: mime,
        file_size: bytes.length,
      });

      if (ins.error) {
        return NextResponse.json(
          { error: `DB insert failed (vehicle_photos): ${ins.error.message}` },
          { status: 500 }
        );
      }
    }

    return NextResponse.json({ ok: true, vin, count: uploadedPaths.length, paths: uploadedPaths });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Upload route error." }, { status: 500 });
  }
}
