import os
import traceback
from datetime import datetime

from flask import Flask, request, jsonify, send_from_directory
from supabase import create_client

app = Flask(__name__)

# -----------------------------
# Supabase config
# -----------------------------
SUPABASE_URL = os.environ.get("SUPABASE_URL") or os.environ.get("NEXT_PUBLIC_SUPABASE_URL") or ""
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or os.environ.get("SUPABASE_SERVICE_KEY") or ""
SUPABASE_ANON_KEY = os.environ.get("SUPABASE_ANON_KEY") or os.environ.get("NEXT_PUBLIC_SUPABASE_ANON_KEY") or ""

# Prefer service role if present (server-side)
SUPABASE_KEY = SUPABASE_SERVICE_KEY or SUPABASE_ANON_KEY

if not SUPABASE_URL or not SUPABASE_KEY:
  print("⚠️ Missing SUPABASE_URL or SUPABASE key. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (recommended).")

supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

# Table names (your chosen flow)
T_CUSTOMER_DATA = "customer_data_legacy"
T_CUSTOMER_JOBS = "customer_jobs_legacy"
T_PHOTOS = "vehicle_photos"


# -----------------------------
# Helpers
# -----------------------------
def normalize_vin(raw: str) -> str:
  return (raw or "").strip().upper().replace(" ", "")

def is_valid_vin(v: str) -> bool:
  # keep it simple; don't block your test VINs if you're using non-standard ones
  return len(v) == 17

def safe_get(d: dict, key: str, default=""):
  try:
    return d.get(key, default)
  except Exception:
    return default

def fmt_date(ts):
  if not ts:
    return ""
  try:
    # Supabase returns ISO strings
    dt = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
    return dt.strftime("%-m/%-d/%Y")
  except Exception:
    try:
      # fallback: just trim
      return str(ts)[:10]
    except Exception:
      return ""

def pick_first_present(row: dict, keys: list, default=""):
  for k in keys:
    val = safe_get(row, k, None)
    if val is not None and str(val).strip() != "":
      return val
  return default


# -----------------------------
# Core: build payload for VIN
# -----------------------------
def build_vehicle_payload(vin: str) -> dict:
  # 1) Customer data (legacy)
  cust = None
  cust_rows = (
    supabase.table(T_CUSTOMER_DATA)
    .select("*")
    .eq("vin", vin)
    .limit(1)
    .execute()
  )
  if cust_rows and getattr(cust_rows, "data", None):
    cust = cust_rows.data[0]

  if not cust:
    # No customer row found, still return photos/history empty rather than hard fail
    return {
      "vin_number": vin,
      "customer_name": "—",
      "phone_number": "—",
      "address": "—",
      "zip_code": "—",
      "email": "—",
      "make": "—",
      "model": "—",
      "year": "—",
      "status": "",
      "notes": "",
      "service_history": [],
      "photo_urls": [],
    }

  # 2) Photos
  photo_urls = []
  try:
    photos_resp = (
      supabase.table(T_PHOTOS)
      .select("*")
      .eq("vin", vin)
      .order("created_at", desc=True)
      .limit(50)
      .execute()
    )
    photos = photos_resp.data if photos_resp and getattr(photos_resp, "data", None) else []
    for p in photos:
      # support several possible column names
      url = pick_first_present(p, ["public_url", "photo_url", "url", "signed_url"], default="")
      if url:
        photo_urls.append(url)
  except Exception:
    # Don't let photos break the whole search
    photo_urls = []

  # 3) Service history (NEW primary: customer_jobs_legacy)
  service_history = []
  jobs = []
  try:
    jobs_resp = (
      supabase.table(T_CUSTOMER_JOBS)
      .select("*")
      .eq("vin", vin)
      .order("created_at", desc=True)
      .limit(25)
      .execute()
    )
    jobs = jobs_resp.data if jobs_resp and getattr(jobs_resp, "data", None) else []
  except Exception:
    jobs = []

  if jobs:
    for j in jobs:
      created_at = pick_first_present(j, ["created_at", "date", "service_date"], default="")
      service_name = pick_first_present(j, ["service_name", "service_type", "job_name", "type"], default="—")
      service_desc = pick_first_present(j, ["service_description", "description", "work_done", "details"], default="")
      notes = pick_first_present(j, ["notes", "service_notes", "note"], default="—")
      nxt = pick_first_present(j, ["next_recommended_service", "next", "next_service"], default="—")

      service_history.append({
        "date": fmt_date(created_at) or "Date N/A",
        "service_type": service_name or "—",
        "service_description": service_desc or "",
        "service_notes": notes or "—",
        "next_recommended_service": nxt or "—",
      })
  else:
    # 4) Fallback: customer_data_legacy.work_done (Intel writes here)
    work_done = pick_first_present(cust, ["work_done", "job_description", "description"], default="")
    if str(work_done).strip():
      service_history.append({
        "date": "Legacy",
        "service_type": "Work Done",
        "service_description": str(work_done),
        "service_notes": "—",
        "next_recommended_service": "—",
      })

  # 5) Map customer fields (support multiple schema variants)
  payload = {
    "vin_number": pick_first_present(cust, ["vin", "vin_number"], default=vin),
    "customer_name": pick_first_present(cust, ["customer_name", "name", "full_name"], default="—"),
    "phone_number": pick_first_present(cust, ["phone_number", "phone", "mobile"], default="—"),
    "address": pick_first_present(cust, ["address", "city_state", "location"], default="—"),
    "zip_code": pick_first_present(cust, ["zip_code", "zip", "postal_code"], default="—"),
    "email": pick_first_present(cust, ["email", "email_address"], default="—"),
    "make": pick_first_present(cust, ["make"], default="—"),
    "model": pick_first_present(cust, ["model"], default="—"),
    "year": pick_first_present(cust, ["year"], default="—"),
    "status": pick_first_present(cust, ["status"], default=""),
    "notes": pick_first_present(cust, ["notes"], default=""),
    "vehicle_nickname": pick_first_present(cust, ["vehicle_nickname"], default=""),
    "service_history": service_history,
    "photo_urls": photo_urls,
  }

  return payload


# -----------------------------
# Routes
# -----------------------------
@app.get("/health")
def health():
  return jsonify({"ok": True})

@app.get("/search")
def search():
  """
  Used by secure dashboard HTML:
    GET /search?vin=...
  Returns JSON payload.
  """
  try:
    vin = normalize_vin(request.args.get("vin", ""))
    if not vin or not is_valid_vin(vin):
      return jsonify({"error": "Please provide a full 17-character VIN."}), 400

    payload = build_vehicle_payload(vin)
    return jsonify(payload), 200

  except Exception as e:
    tb = traceback.format_exc()
    print("🔥 ERROR in /search:", str(e))
    print(tb)
    # Return JSON so the UI shows a real message instead of generic failure
    if request.args.get("debug") == "1":
      return jsonify({"error": str(e), "trace": tb}), 500
    return jsonify({"error": "Server error while searching. Check backend logs."}), 500


# If you're serving the dashboard as a static HTML file from the same flask app:
@app.get("/")
def home():
  # If you keep your HTML in the same folder as app.py as index.html
  # change this to wherever your file lives.
  return send_from_directory(".", "index.html")


if __name__ == "__main__":
  port = int(os.environ.get("PORT", "5000"))
  app.run(host="0.0.0.0", port=port, debug=False) 
