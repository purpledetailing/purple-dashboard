import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Support either naming scheme
const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  "";

const BUCKET =
  process.env.SUPABASE_PHOTO_BUCKET ||
  "vehicle-photos";

// Optional extra protection
const UPLOAD_SECRET =
  process.env.UPLOAD_SECRET ||
  "";

function normalizeVin(raw: string) {
  return (raw || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}
function isValidVin(v: string) {
  return /^[A-HJ-NPR-Z0-9]{17}$/.test(v);
}

export async function POST(req: Request) {
  try {
    // Optional secret header gate (if you set UPLOAD_SECRET)
    if (UPLOAD_SECRET) {
      const got = req.headers.get("x-upload-secret") || "";
      if (got !== UPLOAD_SECRET) {
        return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
      }
    }

    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      return NextResponse.json(
        {
          error:
            "Missing env vars. Need SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY.",
        },
        { status: 500 }
      );
    }

    const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    const form = await req.formData();

    const vinRaw = String(form.get("vin") || "");
    const vin = normalizeVin(vinRaw);

    if (!isValidVin(vin)) {
      return NextResponse.json({ error: "Invalid VIN." }, { status: 400 });
    }

    const files = form.getAll("photos");
    if (!files || files.length === 0) {
      return NextResponse.json({ error: "No photos provided." }, { status: 400 });
    }

    if (files.length > 8) {
      return NextResponse.json({ error: "Max 8 photos." }, { status: 400 });
    }

    const batch_id = crypto.randomUUID();
    const uploaded: { storage_path: string }[] = [];

    for (let i = 0; i < files.length; i++) {
      const item = files[i];
      if (!(item instanceof File)) continue;

      // 8MB cap (should be safe after your client resize)
      const MAX_BYTES = 8 * 1024 * 1024;
      if (item.size > MAX_BYTES) {
        return NextResponse.json(
          { error: "One photo too large (max 8MB)." },
          { status: 413 }
        );
      }

      const ext = "jpg"; // we convert to jpg on client
      const ts = Date.now();
      const safeName = `${i + 1}_${ts}.${ext}`;

      // Store under VIN folder so you can find it in dashboard easily
      const storage_path = `${vin}/${batch_id}/${safeName}`;

      const arrayBuffer = await item.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);

      const { error: upErr } = await supabaseAdmin.storage
        .from(BUCKET)
        .upload(storage_path, bytes, {
          contentType: item.type || "image/jpeg",
          upsert: false,
        });

      if (upErr) {
        return NextResponse.json(
          { error: `Storage upload failed: ${upErr.message}` },
          { status: 500 }
        );
      }

      uploaded.push({ storage_path });
    }

    // Optional: write rows to your table
    // (matches your screenshot: public.vehicle_photos has vin, batch_id, storage_path)
    const rows = uploaded.map((u) => ({
      vin,
      batch_id,
      storage_path: u.storage_path,
    }));

    const { error: insErr } = await supabaseAdmin
      .from("vehicle_photos")
      .insert(rows);

    if (insErr) {
      // Upload succeeded, DB write failed — still return success
      return NextResponse.json(
        { count: uploaded.length, batch_id, warning: `DB insert failed: ${insErr.message}` },
        { status: 200 }
      );
    }

    return NextResponse.json({ count: uploaded.length, batch_id }, { status: 200 });
  } catch (e: any) {
    return NextResponse.json(
      { error: String(e?.message || "Upload failed.") },
      { status: 500 }
    );
  }
}
