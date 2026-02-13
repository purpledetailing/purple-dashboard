from flask import Flask, request, jsonify, render_template
from flask_cors import CORS
import sqlite3
import os
import re
import requests
import traceback
from datetime import datetime

app = Flask(__name__, template_folder="templates", static_folder="../static")
CORS(app)

# ============================================================
# DEBUG: confirm which file is running in production
# ============================================================
APP_VERSION = "2026-02-05-jobs-legacy-descriptions-v2"

@app.route("/version")
def version():
    return jsonify({
        "version": APP_VERSION,
        "running_file": __file__,
        "cwd": os.getcwd(),
    })

# ---------------------------
# SQLite (legacy token support ONLY)
# ---------------------------
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "Customer_Data.db")

PUBLIC_BASE_URL = os.environ.get("PUBLIC_BASE_URL", "").strip().rstrip("/")
if not PUBLIC_BASE_URL:
    PUBLIC_BASE_URL = "http://localhost:5000"

# ---------------------------
# Supabase config
# ---------------------------
def env_flag(name: str, default: str = "1") -> bool:
    v = str(os.environ.get(name, default)).strip().lower()
    return v in ("1", "true", "yes", "y", "on")

USE_SUPABASE = env_flag("USE_SUPABASE", "1")
SUPABASE_URL = (os.environ.get("SUPABASE_URL") or "").rstrip("/")
SUPABASE_SERVICE_ROLE_KEY = (os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or "").strip()

LEGACY_TABLE = os.environ.get("LEGACY_TABLE", "customer_data_legacy").strip()
JOBS_LEGACY_TABLE = os.environ.get("JOBS_LEGACY_TABLE", "customer_jobs_legacy").strip()

PHOTO_BUCKET = os.environ.get("PHOTO_BUCKET", "vehicle-photos").strip()

def supabase_headers():
    return {
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }

def supabase_ready():
    return USE_SUPABASE and bool(SUPABASE_URL) and bool(SUPABASE_SERVICE_ROLE_KEY)

# ---------------------------
# Helpers
# ---------------------------
def get_db():
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    return con

def normalize_vin(vin: str) -> str:
    return (vin or "").strip().upper()

def normalize_token(token: str) -> str:
    return (token or "").strip().lower()

def drive_embed_from_folder(url):
    if not url:
        return None
    m = re.search(r"/folders/([a-zA-Z0-9_\-]+)", str(url))
    if not m:
        return None
    fid = m.group(1)
    return f"https://drive.google.com/embeddedfolderview?id={fid}#grid"

def fmt_date(iso_str: str) -> str:
    if not iso_str:
        return ""
    try:
        s = str(iso_str).replace("Z", "+00:00")
        dt = datetime.fromisoformat(s)
        return dt.strftime("%#m/%#d/%Y") if os.name == "nt" else dt.strftime("%-m/%-d/%Y")
    except Exception:
        return str(iso_str)

from datetime import datetime, date

def _safe_str(v):
    return "" if v is None else str(v)

def _date_to_str(v):
    """
    Accepts date, datetime, or ISO-like strings and returns a friendly date string.
    Falls back to raw string if it can't parse.
    """
    if v is None:
        return ""
    if isinstance(v, date) and not isinstance(v, datetime):
        return v.isoformat()
    if isinstance(v, datetime):
        return v.date().isoformat()

    s = str(v).strip()
    if not s:
        return ""
    # Try to parse common ISO formats: 2026-02-06T02:40:44.607Z, etc.
    try:
        s2 = s.replace("Z", "+00:00")
        dt = datetime.fromisoformat(s2)
        return dt.date().isoformat()
    except Exception:
        return s 

def first_truthy(*vals):
    for v in vals:
        if v is None:
            continue
        s = str(v).strip()
        if s:
            return s
    return ""

def scrub_empty_history_rows(history_rows):
    """
    Remove rows that have no meaningful service_type/description/notes.
    Prevents blank cards in UI.
    """
    out = []
    for r in history_rows or []:
        st = (r.get("service_type") or "").strip()
        sd = (r.get("service_description") or "").strip()
        sn = (r.get("service_notes") or "").strip()
        if st or sd or sn:
            out.append(r)
    return out

# ---------------------------
# Supabase REST helpers
# ---------------------------
def sb_get(path: str, params: dict, timeout: int = 20):
    """
    Generic Supabase REST GET (PostgREST).
    Raises on non-200.
    """
    url = f"{SUPABASE_URL}/rest/v1/{path.lstrip('/')}"
    r = requests.get(url, headers=supabase_headers(), params=params, timeout=timeout)
    if r.status_code != 200:
        raise RuntimeError(f"Supabase GET {path} failed: {r.status_code} {r.text}")
    return r.json() or []

def sb_post(path: str, json_body: dict, timeout: int = 20):
    """
    Generic Supabase REST POST (PostgREST).
    """
    url = f"{SUPABASE_URL}/rest/v1/{path.lstrip('/')}"
    r = requests.post(url, headers=supabase_headers(), json=json_body, timeout=timeout)
    if r.status_code not in (200, 201, 204):
        raise RuntimeError(f"Supabase POST {path} failed: {r.status_code} {r.text}")
    try:
        return r.json()
    except Exception:
        return None

# ---------------------------
# Photos (Supabase Storage)
# ---------------------------
def sb_latest_batch_id_for_vin(vin: str):
    vin = normalize_vin(vin)
    rows = sb_get("vehicle_photos", {
        "select": "batch_id,created_at",
        "vin": f"eq.{vin}",
        "order": "created_at.desc",
        "limit": "1",
    })
    return rows[0]["batch_id"] if rows else None

def sb_photos_for_vin_batch(vin: str, batch_id: str, limit: int = 8):
    vin = normalize_vin(vin)
    rows = sb_get("vehicle_photos", {
        "select": "storage_path,sort_order,created_at",
        "vin": f"eq.{vin}",
        "batch_id": f"eq.{batch_id}",
        "order": "sort_order.asc,created_at.asc",
        "limit": str(limit),
    })
    return rows or []

def sb_sign_storage_url(storage_path: str, expires_in: int = 43200):
    """
    Return a signed URL for a storage object path (PHOTO_BUCKET bucket).
    """
    if not storage_path:
        return None

    storage_path = str(storage_path).lstrip("/")

    url = f"{SUPABASE_URL}/storage/v1/object/sign/{PHOTO_BUCKET}/{storage_path}"
    r = requests.post(
        url,
        headers={
            "apikey": SUPABASE_SERVICE_ROLE_KEY,
            "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
            "Content-Type": "application/json",
        },
        json={"expiresIn": int(expires_in)},
        timeout=20,
    )

    if r.status_code != 200:
        return None

    data = r.json() or {}
    signed_path = data.get("signedURL") or data.get("signedUrl") or ""
    if not signed_path:
        return None

    if signed_path.startswith("http"):
        return signed_path

    if signed_path.startswith("/object/"):
        signed_path = "/storage/v1" + signed_path

    if not signed_path.startswith("/storage/v1/"):
        signed_path = "/storage/v1/" + signed_path.lstrip("/")

    return f"{SUPABASE_URL}{signed_path}"

# ============================================================
# SQLITE (legacy token route fallback)
# ============================================================
def column_exists(table_name, column_name):
    con = get_db()
    cur = con.cursor()
    try:
        cur.execute(f"PRAGMA table_info({table_name})")
        cols = [row[1] for row in cur.fetchall()]
        return column_name in cols
    finally:
        con.close()

def get_vehicle_by_token_sqlite(token):
    token = normalize_token(token)
    if not column_exists("Customer_Data", "access_token"):
        return None

    con = get_db()
    cur = con.cursor()
    cur.execute(
        """
        SELECT *
        FROM Customer_Data
        WHERE LOWER(TRIM(access_token)) = ?
        LIMIT 1
        """,
        (token,),
    )
    r = cur.fetchone()
    con.close()
    return dict(r) if r else None

def get_service_history_for_vin_sqlite(vin):
    con = get_db()
    cur = con.cursor()
    try:
        cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='Service_History'")
        if not cur.fetchone():
            return []

        cur.execute(
            """
            SELECT
              COALESCE(date, '') AS date,
              COALESCE(service_type, '') AS service_type,
              COALESCE(service_notes, '') AS service_notes,
              COALESCE(next_recommended_service, '') AS next_recommended_service,
              COALESCE(photos_link, '') AS photos_link,
              COALESCE(technician, '') AS technician,
              COALESCE(price, '') AS price,
              COALESCE(customer_feedback, '') AS customer_feedback
            FROM Service_History
            WHERE UPPER(TRIM(vehicle_vin)) = ?
            ORDER BY date DESC
            """,
            (normalize_vin(vin),),
        )
        return [dict(r) for r in cur.fetchall()]
    finally:
        con.close()

# ============================================================
# SUPABASE: vehicles + legacy merge
# ============================================================
def sb_vehicle_by_vin(vin: str):
    vin = normalize_vin(vin)
    rows = sb_get("vehicles", {
        "select": "id,vin,year,make,model,trim,color,notes,nickname,service_history_link,access_token,status",
        "vin": f"eq.{vin}",
        "limit": "1",
    })
    return rows[0] if rows else None

def sb_legacy_by_vin(vin: str):
    vin = normalize_vin(vin)
    rows = sb_get(LEGACY_TABLE, {
        "select": "*",
        "vin": f"eq.{vin}",
        "limit": "1",
    })
    return rows[0] if rows else None

def sb_latest_job_for_vehicle(vehicle_id: str):
    # (kept only to help fill missing customer fields)
    rows = sb_get("jobs", {
        "select": "id,performed_at,customer_id",
        "vehicle_id": f"eq.{vehicle_id}",
        "order": "performed_at.desc",
        "limit": "1",
    })
    return rows[0] if rows else None

def sb_customer_by_id(customer_id: str):
    if not customer_id:
        return None
    rows = sb_get("customers", {
        "select": "id,full_name,phone,phone_norm",
        "id": f"eq.{customer_id}",
        "limit": "1",
    })
    return rows[0] if rows else None

# ============================================================
# ✅ OPTION B: PULL JOB HISTORY FROM customer_jobs_legacy
# ============================================================
def sb_jobs_legacy_by_vin(vin: str, limit: int = 50):
    vin = normalize_vin(vin)
    rows = sb_get(JOBS_LEGACY_TABLE, {
        "select": "id,vin,created_at,service_date,service_name,service_description,notes",
        "vin": f"eq.{vin}",
        "order": "service_date.desc,created_at.desc",
        "limit": str(limit),
    })
    return rows or []

def build_history_from_jobs_legacy(vin: str):
    out = []
    try:
        rows = sb_jobs_legacy_by_vin(vin, limit=50)
    except Exception:
        return out

    for r in rows:
        out.append({
            "date": fmt_date(r.get("created_at")),
            "service_type": (r.get("service_name") or "").strip(),
            # ✅ This is what the frontend should show under "Details" when expanded
            "service_description": (r.get("service_description") or "").strip(),
            # ✅ Optional legacy notes (can show as "Notes" if you want)
            "service_notes": (r.get("notes") or "").strip(),
            "next_recommended_service": "",
            "photos_link": "",
            "technician": "",
            "price": "",
            "customer_feedback": "",
        })
    return scrub_empty_history_rows(out)

# ============================================================
# ✅ THIS IS THE FUNCTION YOUR ROUTE MUST CALL
# ============================================================
def merged_profile_by_vin(vin: str):
    vin = normalize_vin(vin)

    veh = sb_vehicle_by_vin(vin)
    legacy = sb_legacy_by_vin(vin)

    if not veh and not legacy:
        return None

    make = first_truthy((veh or {}).get("make"), (legacy or {}).get("make"))
    model = first_truthy((veh or {}).get("model"), (legacy or {}).get("model"))
    year = (veh or {}).get("year") or (legacy or {}).get("year") or ""

    vehicle_nickname = first_truthy((legacy or {}).get("vehicle_nickname"), (veh or {}).get("nickname"), "")
    service_history_link = first_truthy(
        (legacy or {}).get("service_history_link"),
        (veh or {}).get("service_history_link"),
        ""
    )

    status = first_truthy((legacy or {}).get("status"), (veh or {}).get("status"), "")
    notes = first_truthy((legacy or {}).get("notes"), (veh or {}).get("notes"), "")

    # --- Customer fields (legacy primary) ---
    customer_name = first_truthy((legacy or {}).get("customer_name"), "")
    phone_number = first_truthy((legacy or {}).get("phone_number"), "")
    email = first_truthy((legacy or {}).get("email"), "")

    # fallback: if customer missing in legacy, use last normalized job’s customer (optional)
    latest_customer = None
    if veh and veh.get("id"):
        try:
            latest_job = sb_latest_job_for_vehicle(veh["id"])
            if latest_job and latest_job.get("customer_id"):
                latest_customer = sb_customer_by_id(latest_job["customer_id"])
        except Exception:
            latest_customer = None

    if not customer_name and latest_customer:
        customer_name = first_truthy(latest_customer.get("full_name"), "")
    if not phone_number and latest_customer:
        phone_number = first_truthy(latest_customer.get("phone"), "")

    # ✅ Service history from customer_jobs_legacy (Option B)
    service_history = build_history_from_jobs_legacy(vin)

    # --- Photos (latest batch only, max 8) ---
    latest_batch_id = ""
    photo_urls = []
    photo_count = 0

    try:
        batch_id = sb_latest_batch_id_for_vin(vin)
        if batch_id:
            latest_batch_id = batch_id
            rows = sb_photos_for_vin_batch(vin, batch_id, limit=8)
            photo_count = len(rows)

            for r in rows:
                sp = (r.get("storage_path") or "").strip()
                if not sp:
                    continue
                signed = sb_sign_storage_url(sp, expires_in=43200)
                if signed:
                    photo_urls.append(signed)

    except Exception:
        latest_batch_id = ""
        photo_urls = []
        photo_count = 0

    return {
        "veh": veh or {},
        "legacy": legacy or {},
        "latest_customer": latest_customer or {},
        "merged": {
            "vin": vin,
            "make": make,
            "model": model,
            "year": year,
            "status": status,
            "notes": notes,
            "vehicle_nickname": vehicle_nickname,
            "service_history_link": service_history_link,

            "customer_name": customer_name or "—",
            "phone_number": phone_number or "",
            "email": email or "",

            # ✅ Each entry now includes: date, service_type, service_description, service_notes
            "service_history": service_history,
            "photo_count": photo_count,
            "latest_batch_id": latest_batch_id,
            "photo_urls": photo_urls,
        },
    }

# ============================================================
# Routes
# ============================================================
@app.route("/health")
def health():
    return jsonify({
        "ok": True,
        "supabase_ready": supabase_ready(),
        "photo_bucket": PHOTO_BUCKET,
        "db_path": DB_PATH,
        "supabase_url": SUPABASE_URL,
        "legacy_table": LEGACY_TABLE,
        "jobs_legacy_table": JOBS_LEGACY_TABLE,
        "use_supabase": USE_SUPABASE,
    })

@app.route("/health/supabase")
def health_supabase():
    try:
        if not supabase_ready():
            return jsonify({"ok": False, "error": "Supabase env vars not set", "supabase_url": SUPABASE_URL}), 500
        rows = sb_get("vehicles", {"select": "vin", "limit": "1"})
        return jsonify({"ok": True, "status_code": 200, "body": rows}), 200
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500

@app.route("/")
def home():
    return render_template("index.html")

@app.route("/search", methods=["GET"])
def search():
    vin = normalize_vin(request.args.get("vin"))
    if len(vin) != 17:
        return jsonify({"error": "VIN must be 17 characters."}), 400

    if not supabase_ready():
        return jsonify({"error": "Supabase not configured on server."}), 500

    try:
        data = merged_profile_by_vin(vin)
        if not data:
            return jsonify({"error": "Vin not found."}), 404

        legacy = data.get("legacy") or {}
        m = (data.get("merged") or {})

        payload = {
            "customer_id": legacy.get("customer_id"),
            "customer_name": m.get("customer_name") or "—",
            "phone_number": m.get("phone_number") or "",
            "email": legacy.get("email") or (m.get("email") or ""),
            "address": legacy.get("address") or "",
            "zip_code": legacy.get("zip_code") or "",
            "vehicle_nickname": legacy.get("vehicle_nickname") or "",
            "vin_number": m.get("vin") or vin,
            "make": m.get("make") or "",
            "model": m.get("model") or "",
            "year": m.get("year") or "",
            "status": m.get("status") or "",
            "notes": m.get("notes") or "",
            # ✅ now includes service_description per entry
            "service_history": m.get("service_history") or [],
            "photo_urls": m.get("photo_urls") or [],
            "access_token": (data.get("veh") or {}).get("access_token"),
            "customer_portal_url": f"{request.host_url.rstrip('/')}/vin/{vin}",
        }

        return jsonify(payload), 200

    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/vin/<value>")
def public_report(value):
    """
    Public:
      - /vin/<VIN> (17 chars) -> Supabase merge + customer_jobs_legacy history
      - /vin/<TOKEN> (not 17) -> SQLite token (legacy support)
    """
    try:
        value = (value or "").strip()

        # VIN route
        if len(value) == 17:
            vin = normalize_vin(value)

            if not supabase_ready():
                return render_template("public_report.html", not_found=True, vin=vin), 500

            data = merged_profile_by_vin(vin)
            if not data:
                return render_template("public_report.html", not_found=True, vin=vin), 404

            m = (data.get("merged") or {})

            vehicle_for_template = {
                "vin_number": vin,
                "make": m.get("make") or "",
                "model": m.get("model") or "",
                "year": m.get("year") or "",
            }

            embed_url = drive_embed_from_folder(m.get("service_history_link") or "")
            photo_urls = m.get("photo_urls") or []

            return render_template(
                "public_report.html",
                not_found=False,
                vin=vin,
                vehicle=vehicle_for_template,
                # ✅ contains service_description now
                service_history=m.get("service_history") or [],
                embed_url=embed_url,
                photo_urls=photo_urls,
            )

        # TOKEN route (legacy)
        token = normalize_token(value)
        vehicle = get_vehicle_by_token_sqlite(token)
        if not vehicle:
            return render_template("public_report.html", not_found=True, vin="—"), 404

        vin = normalize_vin(vehicle.get("vin_number"))

        # ALWAYS HIDE on public
        vehicle["phone_number"] = ""
        vehicle["address"] = ""
        vehicle["zip_code"] = ""
        vehicle["email"] = ""

        history = get_service_history_for_vin_sqlite(vin)
        embed_url = drive_embed_from_folder(vehicle.get("service_history_link"))

        return render_template(
            "public_report.html",
            not_found=False,
            vin=vin,
            vehicle=vehicle,
            service_history=history,
            embed_url=embed_url,
            photo_urls=[],
        )

    except Exception as e:
        tb = traceback.format_exc()
        print("🔥 ERROR in /vin route:", str(e))
        print(tb)

        if request.args.get("debug") == "1":
            return f"<pre>{tb}</pre>", 500

        return "Internal Server Error", 500

if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5000"))
    app.run(host="0.0.0.0", port=port, debug=False)
