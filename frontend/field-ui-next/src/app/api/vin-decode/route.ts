import { NextResponse } from "next/server";

function normalizeVin(raw: string) {
  return raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const vinRaw = searchParams.get("vin") ?? "";
  const vin = normalizeVin(vinRaw);

  if (vin.length !== 17) {
    return NextResponse.json({ error: "VIN must be 17 characters." }, { status: 400 });
  }

  // NHTSA vPIC Decode VIN endpoint
  const url = `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/${vin}?format=json`;

  try {
    const r = await fetch(url, { cache: "no-store" });

    if (!r.ok) {
      return NextResponse.json({ error: `Decode failed (${r.status})` }, { status: 502 });
    }

    const json = await r.json();
    const row = json?.Results?.[0] ?? {};

    // vPIC returns strings (often empty)
    const modelYearStr = (row?.ModelYear ?? "").toString().trim();
    const yearNum = Number(modelYearStr);
    const year = Number.isFinite(yearNum) && yearNum > 0 ? yearNum : null;

    const make = (row?.Make ?? "").toString().trim() || null;
    const model = (row?.Model ?? "").toString().trim() || null;
    const trim = (row?.Trim ?? "").toString().trim() || null;

    // Helpful debug fields (kept small)
    const ErrorCode = (row?.ErrorCode ?? null)?.toString?.() ?? row?.ErrorCode ?? null;
    const ErrorText = (row?.ErrorText ?? null)?.toString?.() ?? row?.ErrorText ?? null;

    return NextResponse.json({
      vin,
      year,
      make,
      model,
      trim,
      raw: { ErrorCode, ErrorText },
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Decode error" }, { status: 500 });
  }
}
