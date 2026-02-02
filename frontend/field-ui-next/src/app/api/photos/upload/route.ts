import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const BUCKET = process.env.SUPABASE_PHOTO_BUCKET || "vehicle-photos";

// ✅ Add this env var and send header x-upload-secret
const UPLOAD_SECRET = process.env.UPLOAD_SECRET || "";

function normalizeVin(raw: string) {
  return (raw || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}
function isValidVin(vin: string) {
  return /^[A-HJ-NPR-Z0-9]{17}$/.test(vin);
}

function normalizeBatchId(raw: string) {
  const v = (raw || "").trim();
  // basic UUID format check
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v)) {
    return v;
  }
  return "";
}

function getExtFromMime(mime: string) {
  const m = (mime || "").toLowerCase();
  if (m.includes("png")) return "png";
  if (m.includes("webp")) return "webp";
  if (m.includes("heic") || m.includes("heif")) return "heic";
  if (m.includes("jpeg") || m.includes("jpg")) return "jpg";
  return "jpg";
}

export async function POST(req: Request) {
  const uploadedPaths: string[] = [];

  try {
    // ✅ Basic hardening (highly recommended)
    if (UPLOAD_SECRET) {
      const headerSecret = req.headers.get("x-upload-secret") || "";
      if (headerSecret !== UPLOAD_SECRET) {
        return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
      }
    }

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

    // ✅ Allow client to provide batch_id (optional)
    const providedBatch = normalizeBatchId(String(form.get("batch_id") || ""));
    const batch_id = providedBatch || randomUUID();

    const photos = form.getAll("photos").filter(Boolean) as File[];
    if (!photos || photos.length === 0) {
      return NextResponse.json({ error: "No photos received." }, { status: 400 });
    }
    if (photos.length > 8) {
      return NextResponse.json({ error: "Max 8 photos per upload." }, { status: 400 });
    }

    // ✅ file validation: type + size
    const MAX_BYTES_PER_FILE = 8 * 1024 * 1024; // 8MB
    const allowed = new Set([
      "image/jpeg",
      "image/jpg",
      "image/png",
      "image/webp",
      "image/heic",
      "image/heif",
    ]);

    for (const f of photos) {
      const mime = (f.type || "").toLowerCase();
      if (mime && !allowed.has(mime)) {
        return NextResponse.json({ error: `Unsupported file type: ${f.type}` }, { status: 400 });
      }
      if (typeof f.size === "number" && f.size > MAX_BYTES_PER_FILE) {
        return NextResponse.json({ error: `File too large: ${f.name} (max 8MB)` }, { status: 400 });
      }
    }

    const uploadedRows: Array<{
      vin: string;
      batch_id: string;
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

      const mime = (file.type || "image/jpeg").toLowerCase();
      const ext = getExtFromMime(mime);

      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const safeName = (file.name || `photo.${ext}`).replace(/[^a-zA-Z0-9._-]/g, "_");

      // ✅ Slightly cleaner prefix (optional)
      const storage_path = `vin/${vin}/${batch_id}/${String(i).padStart(2, "0")}_${stamp}_${safeName}`;

      const up = await supabaseAdmin.storage.from(BUCKET).upload(storage_path, bytesArr, {
        contentType: mime,
        upsert: false,
      });

      if (up.error) {
        return NextResponse.json({ error: `Storage upload failed: ${up.error.message}` }, { status: 500 });
      }

      uploadedPaths.push(storage_path);

      uploadedRows.push({
        vin,
        batch_id,
        storage_path,
        original_filename: file.name || null,
        content_type: mime || null,
        bytes: bytesArr.length,
        sort_order: i,
      });
    }

    const { error: insErr } = await supabaseAdmin.from("vehicle_photos").insert(uploadedRows);

    if (insErr) {
      // ✅ cleanup storage if DB insert fails
      if (uploadedPaths.length) {
        await supabaseAdmin.storage.from(BUCKET).remove(uploadedPaths);
      }
      return NextResponse.json({ error: `DB insert failed (vehicle_photos): ${insErr.message}` }, { status: 500 });
    }

    return NextResponse.json({
      ok: true,
      vin,
      batch_id,
      count: uploadedRows.length,
      paths: uploadedRows.map((r) => r.storage_path),
    });
  } catch (e: any) {
    // ✅ cleanup on unexpected crash after uploads
    try {
      if (uploadedPaths.length && SUPABASE_URL && SERVICE_ROLE_KEY) {
        const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
          auth: { persistSession: false },
        });
        await supabaseAdmin.storage.from(BUCKET).remove(uploadedPaths);
      }
    } catch {}

    return NextResponse.json({ error: e?.message || "Upload route error." }, { status: 500 });
  }
}
