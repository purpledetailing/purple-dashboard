// app/api/photos/upload/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

const BUCKET = "vehicle-photos";

function cleanEnv(v: string | undefined | null) {
  return (v ?? "").trim();
}

function cleanUrl(v: string | undefined | null) {
  // Remove ALL whitespace (spaces/newlines) because one stray space breaks it.
  return (v ?? "").trim().replace(/\s+/g, "").replace(/\/$/, "");
}

function getSupabaseUrl() {
  // Prefer server var, fall back to NEXT_PUBLIC (since you have both)
  return cleanUrl(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL);
}

function getServiceRoleKey() {
  // Support either env var name (people commonly use both)
  return cleanEnv(
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.SUPABASE_SERVICE_ROLE ||
      process.env.SUPABASE_SERVICE_KEY
  );
}

function safeFilename(name: string) {
  return (name || "photo")
    .replace(/[^\w.\-]+/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 120);
}

export async function POST(req: Request) {
  const supabaseUrl = getSupabaseUrl();
  const serviceRoleKey = getServiceRoleKey();

  // 🔎 Debug: prove exactly what the route sees at runtime
  const debug = {
    got: {
      SUPABASE_URL: Boolean(cleanEnv(process.env.SUPABASE_URL)),
      NEXT_PUBLIC_SUPABASE_URL: Boolean(cleanEnv(process.env.NEXT_PUBLIC_SUPABASE_URL)),
      SUPABASE_SERVICE_ROLE_KEY: Boolean(cleanEnv(process.env.SUPABASE_SERVICE_ROLE_KEY)),
    },
    sanitized: {
      supabaseUrlPreview: supabaseUrl ? `${supabaseUrl.slice(0, 20)}...` : "",
      supabaseUrlLen: supabaseUrl.length,
      serviceRoleKeyLen: serviceRoleKey.length,
    },
    bucket: BUCKET,
  };

  if (!supabaseUrl || !serviceRoleKey) {
    return NextResponse.json(
      {
        error:
          "Missing env vars. Need SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY.",
        debug,
      },
      { status: 500 }
    );
  }

  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  try {
    const form = await req.formData();

    const vinRaw = String(form.get("vin") || form.get("vehicle_vin") || "")
      .trim()
      .toUpperCase();

    const batch_id = String(form.get("batch_id") || crypto.randomUUID()).trim();

    const files = form.getAll("photos").filter((x): x is File => x instanceof File);

    if (!vinRaw || vinRaw.length !== 17) {
      return NextResponse.json({ error: "VIN missing or not 17 chars.", debug }, { status: 400 });
    }

    if (files.length === 0) {
      return NextResponse.json(
        { error: "No photos received. Expected form field name: photos", debug },
        { status: 400 }
      );
    }

    // Upload max 8
    const toUpload = files.slice(0, 8);

    const uploaded: { storage_path: string; sort_order: number }[] = [];
    const upload_errors: { name: string; message: string }[] = [];

    for (let i = 0; i < toUpload.length; i++) {
      const file = toUpload[i];

      const ab = await file.arrayBuffer();
      const buf = Buffer.from(ab);

      const cleanName = safeFilename(file.name);

      // Put in a folder per VIN + batch
      const storage_path = `${vinRaw}/${batch_id}/${String(i + 1).padStart(2, "0")}_${Date.now()}_${cleanName}`;

      const { error: upErr } = await supabaseAdmin.storage.from(BUCKET).upload(storage_path, buf, {
        contentType: file.type || "image/jpeg",
        upsert: false,
      });

      if (upErr) {
        upload_errors.push({ name: file.name, message: upErr.message });
        continue;
      }

      uploaded.push({ storage_path, sort_order: i + 1 });
    }

    // If nothing uploaded, return hard failure (don’t “pretend success”)
    if (uploaded.length === 0) {
      return NextResponse.json(
        { error: "All uploads failed.", upload_errors, debug },
        { status: 500 }
      );
    }

    // Insert DB rows (non-fatal if it fails)
    const rows = uploaded.map((u) => ({
      vin: vinRaw,
      batch_id,
      storage_path: u.storage_path,
      sort_order: u.sort_order,
    }));

    const { error: insErr } = await supabaseAdmin.from("vehicle_photos").insert(rows);

    if (insErr) {
      return NextResponse.json(
        {
          count: uploaded.length,
          batch_id,
          uploaded,
          upload_errors,
          warning: `DB insert failed: ${insErr.message}`,
          debug,
        },
        { status: 200 }
      );
    }

    return NextResponse.json(
      { count: uploaded.length, batch_id, uploaded, upload_errors, debug },
      { status: 200 }
    );
  } catch (e: any) {
    return NextResponse.json(
      { error: String(e?.message || "Upload failed."), debug },
      { status: 500 }
    );
  }
}
