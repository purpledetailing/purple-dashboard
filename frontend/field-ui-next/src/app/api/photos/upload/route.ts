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

// Generate a UUID without needing crypto.randomUUID() support everywhere
function uuidv4() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c: any = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();

  // fallback
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);

  // RFC 4122 version 4
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
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
      return NextResponse.json({ error: "Invalid VIN (must be 17 chars, no I/O/Q)." }, { status: 400 });
    }

    const photos = form.getAll("photos").filter(Boolean) as File[];
    if (!photos || photos.length === 0) {
      return NextResponse.json({ error: "No photos received." }, { status: 400 });
    }
    if (photos.length > 8) {
      return NextResponse.json({ error: "Max 8 photos per upload." }, { status: 400 });
    }

    // ✅ REQUIRED by your schema
    const batch_id = uuidv4();

    const uploaded: Array<{
      storage_path: string;
      original_filename: string | null;
      content_type: string | null;
      bytes: number;
      sort_order: number;
    }> = [];

    for (let i = 0; i < photos.length; i++) {
      const file = photos[i];

      const arrayBuffer = await file.arrayBuffer();
      const bytesArr = new Uint8Array(arrayBuffer);

      const mime = file.type || "image/jpeg";
      const ext =
        mime.includes("png") ? "png" :
        mime.includes("webp") ? "webp" :
        mime.includes("heic") ? "heic" :
        "jpg";

      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const safeName = (file.name || `photo.${ext}`).replace(/[^a-zA-Z0-9._-]/g, "_");

      // keep it simple & queryable by VIN
      const storage_path = `${vin}/${batch_id}/${String(i).padStart(2, "0")}_${stamp}_${safeName}`;

      const up = await supabaseAdmin.storage.from(BUCKET).upload(storage_path, bytesArr, {
        contentType: mime,
        upsert: false,
      });

      if (up.error) {
        return NextResponse.json({ error: `Storage upload failed: ${up.error.message}` }, { status: 500 });
      }

      uploaded.push({
        storage_path,
        original_filename: file.name || null,
        content_type: mime || null,
        bytes: bytesArr.length,
        sort_order: i,
      });
    }

    // ✅ Insert rows into your exact table schema
    const { error: insErr } = await supabaseAdmin.from("vehicle_photos").insert(
      uploaded.map((u) => ({
        vin,
        batch_id,
        storage_path: u.storage_path,
        original_filename: u.original_filename,
        content_type: u.content_type,
        bytes: u.bytes, // bigint column accepts JS number here
        sort_order: u.sort_order,
      }))
    );

    if (insErr) {
      return NextResponse.json({ error: `DB insert failed (vehicle_photos): ${insErr.message}` }, { status: 500 });
    }

    return NextResponse.json({
      ok: true,
      vin,
      batch_id,
      count: uploaded.length,
      paths: uploaded.map((u) => u.storage_path),
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Upload route error." }, { status: 500 });
  }
}
