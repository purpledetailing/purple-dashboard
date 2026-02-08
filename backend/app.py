import os
import traceback
from datetime import datetime

from flask import Flask, jsonify, request, render_template, abort
from supabase import create_client

# ----------------------------
# Config
# ----------------------------
SUPABASE_URL = os.environ.get("SUPABASE_URL") or os.environ.get("NEXT_PUBLIC_SUPABASE_URL") or ""
SUPABASE_SERVICE_ROLE_KEY = (
    os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    or os.environ.get("SUPABASE_SERVICE_KEY")
    or os.environ.get("SUPABASE_KEY")
    or ""
)

# If you store photo paths in a bucket and need to build URLs
SUPABASE_PHOTO_BUCKET = os.environ.get("SUPABASE_PHOTO_BUCKET") or "vehicle-photos"

# Optional: enforce a public base (otherwise uses request.host_url)
PUBLIC_BASE_URL = os.environ.get("PUBLIC_BASE_URL", "").rstrip("/")

app = Flask(__name__, template_folder="templates")

if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
    print("⚠️ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env vars.")

supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)


# ----------------------------
# Helpers
# ----------------------------
def normalize_vin(raw: str) -> str:
    return (raw or "").strip().upper().replace(" ", "")

def is_valid_vin(v: str) -> bool:
    # simple 17-char check; keep it lightweight
    return bool(v) and len(v) == 17

def iso_to_mmddyyyy(s: str) -> str:
    """
    Convert Supabase timestamps like 2026-02-06T02:40:44.607291+00:00
    to M/D/YYYY. If parsing fails, return original.
    """
    if not s:
        return ""
    try:
        # handle Z or +00:00
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        return f"{dt.month}/{dt.day}/{dt.year}"
    except Exception:
        return s

def build_photo_url(row: dict) -> str:
    """
    Accepts a row from vehicle_photos (or similar).
    Supports:
      - row['url'] or row['photo_url'] already public
      - row['path'] => build public bucket url
    """
    if not row:
        return ""
    for k in ("url", "photo_url", "public_url"):
        if row.get(k):
            return row[k]

    path = row.get("path") or row.get("file_path") or row.get("storage_path")
    if path and SUPABASE_URL:
        # public bucket URL format:
        return f"{SUPABASE_URL}/storage/v1/object/public/{SUPABASE_PHOTO_BUCKET}/{path.lstrip('/')}"
    return ""


def get_customer_vehicle_by_vin(vin: str) -> dict:
    """
    Tries multiple places because your schema evolved.
    Returns a dict with customer + vehicle fields.
    """
    # 1) customers table with vin on it
    cust = supabase.table("customers").select("*").eq("vin", vin).limit(1).execute()
    if cust.data:
        return {"source": "customers", **cust.data[0]}

    # 2) customer_data_legacy with vin on it
    legacy = supabase.table("customer_data_legacy").select("*").eq("vin", vin).limit(1).execute()
    if legacy.data:
        return {"source": "customer_data_legacy", **legacy.data[0]}

    # 3) vehicles table with vin on it
    veh = supabase.table("vehicles").select("*").eq("vin", vin).limit(1).execute()
    if veh.data:
        return {"source": "vehicles", **veh.data[0]}

    return {}


def get_service_history_legacy(vin: str) -> list:
    """
    ✅ THIS is the fix: pull from customer_jobs_legacy.
    Your HTML expects payload.service_history as an array of:
      { date, service_type, service_description, service_notes, next_recommended_service }
    """
    res = (
        supabase.table("customer_jobs_legacy")
        .select("id, vin, created_at, service_name, service_description, notes, next_recommended_service")
        .eq("vin", vin)
        .order("created_at", desc=True)
        .limit(50)
        .execute()
    )

    out = []
    for r in (res.data or []):
        out.append(
            {
                "date": iso_to_mmddyyyy(r.get("created_at") or ""),
                "service_type": r.get("service_name") or "—",
                "service_description": r.get("service_description") or "",
                "service_notes": r.get("notes") or "—",
                "next_recommended_service": r.get("next_recommended_service") or "—",
                "id": r.get("id"),
            }
        )
    return out


def get_photo_urls(vin: str) -> list:
    """
    Tries vehicle_photos (common)
    """
    res = (
        supabase.table("vehicle_photos")
        .select("*")
        .eq("vin", vin)
        .order("created_at", desc=True)
        .limit(60)
        .execute()
    )
    urls = []
    for r in (res.data or []):
        u = build_photo_url(r)
        if u:
            urls.append(u)
    return urls


def make_payload(vin: str) -> dict:
    info = get_customer_vehicle_by_vin(vin)

    # Normalize field names across old/new schemas
    customer_name = info.get("customer_name") or info.get("name") or info.get("full_name") or "—"
    phone_number = info.get("phone_number") or info.get("phone") or "—"
    address = info.get("address") or info.get("city_state") or info.get("location") or "—"
    zip_code = info.get("zip_code") or info.get("zip") or "—"
    email = info.get("email") or info.get("email_address") or ""
    status = info.get("status") or info.get("customer_status") or ""
    notes = info.get("notes") or info.get("customer_notes") or ""

    make = info.get("make") or info.get("vehicle_make") or "—"
    model = info.get("model") or info.get("vehicle_model") or "—"
    year = info.get("year") or info.get("vehicle_year") or "—"

    service_history = get_service_history_legacy(vin)
    photo_urls = get_photo_urls(vin)

    base = PUBLIC_BASE_URL or request.host_url.rstrip("/")

    return {
        "vin_number": vin,
        "customer_name": customer_name,
        "phone_number": phone_number,
        "address": address,
        "zip_code": zip_code,
        "email": email,
        "status": status,
        "notes": notes,
        "make": make,
        "model": model,
        "year": year,
        "service_history": service_history,
        "photo_urls": photo_urls,
        "public_url": f"{base}/vin/{vin}",
    }


# ----------------------------
# Routes
# ----------------------------
@app.get("/")
def home():
    # ✅ Fix: use templates/index.html instead of "index.html next to app.py"
    return render_template("index.html")


@app.get("/search")
def search():
    vin = normalize_vin(request.args.get("vin", ""))
    if not is_valid_vin(vin):
        return jsonify({"error": "Please provide a valid 17-character VIN."}), 400

    try:
        payload = make_payload(vin)

        # If there’s literally no record AND no photos AND no jobs, treat as not found
        has_any = (
            payload.get("customer_name") not in ("—", "", None)
            or (payload.get("photo_urls") or [])
            or (payload.get("service_history") or [])
        )
        if not has_any:
            return jsonify({"error": "No customer/vehicle found for that VIN."}), 404

        return jsonify(payload), 200

    except Exception as e:
        tb = traceback.format_exc()
        print("🔥 ERROR in /search:", str(e))
        print(tb)
        return jsonify({"error": "Internal Server Error"}), 500


@app.get("/vin/<vin>")
def public_vehicle(vin):
    """
    ✅ Fix: customer portal URL route exists again.
    This is the read-only customer view.
    """
    vin = normalize_vin(vin)
    if not is_valid_vin(vin):
        abort(404)

    try:
        payload = make_payload(vin)

        has_any = (
            payload.get("customer_name") not in ("—", "", None)
            or (payload.get("photo_urls") or [])
            or (payload.get("service_history") or [])
        )
        if not has_any:
            abort(404)

        return render_template("public_vehicle.html", payload=payload)

    except Exception as e:
        tb = traceback.format_exc()
        print("🔥 ERROR in /vin route:", str(e))
        print(tb)

        if request.args.get("debug") == "1":
            return f"<pre>{tb}</pre>", 500

        return "Internal Server Error", 500


@app.get("/health")
def health():
    return jsonify({"ok": True}), 200


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5000"))
    app.run(host="0.0.0.0", port=port, debug=False) 
