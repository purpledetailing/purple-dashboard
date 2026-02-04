// app/api/photos/upload/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs"; // we use Buffer

const BUCKET = process.env.PHOTO_BUCKET?.trim() || "vehicle-photos";
const MAX_PHOTOS = 8;

function env(name: string) {
  return (process.env[name] || "").trim();
}

function getSupabaseUrl() {
  return (
    env("SUPABASE_URL") ||
    env("NEXT_PUBLIC_SUPABASE_URL") ||
    env("NEXT_PUBLIC_SUPABASE_URL".toUpperCase()) // harmless fallback
  ).replace(/\/$/, "");
}

function getServiceRoleKey() {
  return env("SUPABASE_SERVICE_ROLE_KEY");
}

function normalizeVin(v: string) {
  return (v || "").trim().toUpperCase();
}

function safeFilename(name: string) {
  // keep it simple and filesystem-safe for object storage
  return (name || "photo.jpg")
    .trim()
    .replace(/[^\w.\-]+/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 80);
}

function extFromContentType(ct?: string) {
  if (!ct) return "";
  if (ct.includes("jpeg")) return ".jpg";
  if (ct.includes("png")) return ".png";
  if (ct.includes("webp")) return ".webp";
  if (ct.includes("heic")) return ".heic";
  return "";
}

export async function POST(req: Request) {
  try {
    const SUPABASE_URL = getSupabaseUrl();
    const SERVICE_ROLE = getServiceRoleKey();

    if (!SUPABASE_URL || !SERVICE_ROLE) {
      return NextResponse.json(
        {
          error:
            "Missing env vars. Need SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY.",
          got: {
            SUPABASE_URL: !!SUPABASE_URL,
            NEXT_PUBLIC_SUPABASE_URL: !!env("NEXT_PUBLIC_SUPABASE_URL"),
            SUPABASE_SERVICE_ROLE_KEY: !!SERVICE_ROLE,
          },
        },
        { status: 500 }
      );
    }

    const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const fd = await req.formData();

    // We support either:
    // - vin in formData
    // - vehicle_vin in formData
    const vin = normalizeVin(
      String(fd.get("vin") || fd.get("vehicle_vin") || "")
    );

    if (vin.length !== 17) {
      return NextResponse.json(
        { error: "VIN must be 17 characters." },
        { status: 400 }
      );
    }

    // photos[] are appended as "photos" (as in your screenshot)
    const incoming = fd.getAll("photos");
    const files = incoming.filter((x): x is File => x instanceof File);

    if (!files.length) {
      return NextResponse.json(
        { error: "No photos received. Make sure formData uses key 'photos'." },
        { status: 400 }
      );
    }

    const selected = files.slice(0, MAX_PHOTOS);
    const batch_id =
      String(fd.get("batch_id") || "").trim() || crypto.randomUUID();

    const uploaded: { storage_path: string; name: string }[] = [];
    const uploadErrors: { name: string; error: string }[] = [];

    for (let i = 0; i < selected.length; i++) {
      const f = selected[i];

      // Build a stable storage path
      const ts = Date.now();
      const base = safeFilename(f.name);
      const ext = base.includes(".") ? "" : extFromContentType(f.type);
      const filename = `${String(i + 1).padStart(2, "0")}_${ts}_${base}${ext}`;
      const storage_path = `${vin}/${batch_id}/${filename}`;

      try {
        const ab = await f.arrayBuffer();
        const buf = Buffer.from(ab);

        const { error: upErr } = await supabaseAdmin.storage
          .from(BUCKET)
          .upload(storage_path, buf, {
            contentType: f.type || "application/octet-stream",
            upsert: false,
            cacheControl: "3600",
          });

        if (upErr) {
          uploadErrors.push({ name: f.name, error: upErr.message });
          continue;
        }

        uploaded.push({ storage_path, name: f.name });
      } catch (e: any) {
        uploadErrors.push({
          name: f.name,
          error: String(e?.message || "Upload failed"),
        });
      }
    }

    // Even if some uploads fail, we still insert the successful ones
    const rows = uploaded.map((u, idx) => ({
      vin,
      batch_id,
      storage_path: u.storage_path,
      sort_order: idx + 1,
    }));

    if (rows.length) {
      const { error: insErr } = await supabaseAdmin
        .from("vehicle_photos")
        .insert(rows);

      if (insErr) {
        // Upload succeeded, DB write failed — still return success
        return NextResponse.json(
          {
            count: uploaded.length,
            batch_id,
            uploaded,
            upload_errors: uploadErrors,
            warning: `DB insert failed: ${insErr.message}`,
          },
          { status: 200 }
        );
      }
    }

    return NextResponse.json(
      {
        count: uploaded.length,
        batch_id,
        uploaded,
        upload_errors: uploadErrors,
        message:
          uploadErrors.length && uploaded.length
            ? "Some photos uploaded, some failed."
            : uploadErrors.length
            ? "All uploads failed."
            : "Uploaded successfully.",
      },
      { status: uploaded.length ? 200 : 500 }
    );
  } catch (e: any) {
    return NextResponse.json(
      { error: String(e?.message || "Upload failed.") },
      { status: 500 }
    );
  }
}
```0
