// ✅ Drop-in replacement block (replace your current insert + return section with this)
const { data: inserted, error: insErr } = await supabaseAdmin
  .from("vehicle_photos")
  .insert(rows)
  .select("id, vin, batch_id, storage_path");

if (insErr) {
  // IMPORTANT: If DB insert fails, the storage upload might still have succeeded.
  // Return 500 so the UI doesn't lie, but include debug details.
  console.error("vehicle_photos insert failed:", {
    message: insErr.message,
    details: (insErr as any).details,
    hint: (insErr as any).hint,
    code: (insErr as any).code,
    batch_id,
    vin,
    rowsPreview: rows?.slice?.(0, 2),
  });

  return NextResponse.json(
    {
      error: "Upload succeeded but DB insert failed.",
      uploaded_count: uploaded.length,
      batch_id,
      db_error: {
        message: insErr.message,
        details: (insErr as any).details,
        hint: (insErr as any).hint,
        code: (insErr as any).code,
      },
      uploaded_paths: uploaded.map((u: any) => u?.path || u?.storage_path || u),
    },
    { status: 500 }
  );
}

return NextResponse.json(
  {
    count: uploaded.length,
    batch_id,
    inserted: inserted || [],
    uploaded_paths: uploaded.map((u: any) => u?.path || u?.storage_path || u),
  },
  { status: 200 }
);
```0



