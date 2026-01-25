from flask import Flask, request, jsonify, render_template
from flask_cors import CORS
import sqlite3
import os
import re
import secrets
import requests
from datetime import datetime

app = Flask(__name__, template_folder="templates", static_folder="../static")
CORS(app)

# ============================================================
# DEBUG: confirm which file is running in production
# ============================================================
APP_VERSION = "2026-01-25-supabase-legacy-merge-v4"

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
USE_SUPABASE = os.environ.get("USE_SUPABASE", "1").strip() == "1"
SUPABASE_URL = (os.environ.get("SUPABASE_URL") or "").rstrip("/")
SUPABASE_SERVICE_ROLE_KEY = (os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or "").strip()

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

def first_truthy(*vals):
    for v in vals:
        if v is None:
            continue
        s = str(v).strip()
        if s:
            return s
    return ""

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
    # Optional: if you still have Service_History in SQLite
    con = get_db()
    cur = con.cursor()
    try:
        cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='Service_History'")
        if not cur.fetchone():
            return []
        cur.execute(
            """
            SELECT
              COALESCE(date, '')                     AS date,
              COALESCE(service_type, '')             AS service_type,
              COALESCE(service_notes, '')            AS service_notes,
              COALESCE(next_recommended_service, '') AS next_recommended_service,
              COALESCE(photos_link, '')              AS photos_link,
              COALESCE(technician, '')               AS technician,
              COALESCE(price, '')                    AS price,
              COALESCE(customer_feedback, '')        AS customer_feedback
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
# SUPABASE: vehicles + customer_data_legacy merge
# ============================================================
def sb_vehicle_by_vin(vin: str):
    """
    public.vehicles has column: vin (text)
    """
    vin = normalize_vin(vin)
    rows = sb_get("vehicles", {
        "select": "id,vin,year,make,model,trim,color,notes,nickname,service_history_link,access_token,status",
        "vin": f"ilike.{vin}",
        "limit": "1",
    })
    return rows[0] if rows else None

def sb_legacy_by_vin(vin: str):
    """
    public.customer_data_legacy has column: vin (text) + customer fields + service_history_link
    """
    vin = normalize_vin(vin)
    rows = sb_get("customer_data_legacy", {
        "select": "id,customer_id,customer_name,status,phone_number,email,address,zip_code,vehicle_nickname,vin,make,model,year,license_plate_optional,odometer_at_last_service,lease_or_owned,primary_use,notes,service_history_link",
        "vin": f"ilike.{vin}",
        "limit": "1",
    })
    return rows[0] if rows else None

def sb_jobs_by_vehicle(vehicle_id: str, limit: int = 25):
    """
    public.jobs - keep minimal columns; safe against schema differences.
    If RLS blocks jobs, caller should handle exception.
    """
    rows = sb_get("jobs", {
        "select": "id,performed_at,notes,total_price_cents,vehicle_id,customer_id",
        "vehicle_id": f"eq.{vehicle_id}",
        "order": "performed_at.desc",
        "limit": str(limit),
    })
    return rows

def sb_job_services(job_id: str):
    """
    public.job_services join services - if blocked by RLS, return empty list.
    """
    url = f"{SUPABASE_URL}/rest/v1/job_services"
    params = {
        "select": "service_id,services(name,category)",
        "job_id": f"eq.{job_id}",
    }
    r = requests.get(url, headers=supabase_headers(), params=params, timeout=20)
    if r.status_code != 200:
        return []
    return r.json() or []

def build_history_from_jobs(vehicle_id: str):
    """
    Return service_history[] in your expected shape using jobs + job_services + services.
    """
    out = []
    try:
        jobs = sb_jobs_by_vehicle(vehicle_id, limit=25)
    except Exception:
        return out

    for j in jobs:
        service_label = ""
        try:
            js = sb_job_services(j.get("id"))
            names = []
            for row in js:
                s = row.get("services") or {}
                nm = (s.get("name") or "").strip()
                if nm:
                    names.append(nm)
            if names:
                service_label = names[0]
                if len(names) > 1:
                    service_label = f"{names[0]} (+{len(names)-1})"
        except Exception:
            service_label = ""

        out.append({
            "date": fmt_date(j.get("performed_at")),
            "service_type": service_label or "",
            "service_notes": (j.get("notes") or ""),
            "next_recommended_service": "",
            "photos_link": "",
            "technician": "",
            "price": "",
            "customer_feedback": "",
        })
    return out

def merged_profile_by_vin(vin: str):
    """
    Merge record from:
      - vehicles (authoritative for VIN + core vehicle)
      - customer_data_legacy (authoritative for customer info + drive folder link)
    Either table can be missing; if both missing -> None
    """
    vin = normalize_vin(vin)

    veh = sb_vehicle_by_vin(vin)
    legacy = sb_legacy_by_vin(vin)

    if not veh and not legacy:
        return None

    make = first_truthy((veh or {}).get("make"), (legacy or {}).get("make"))
    model = first_truthy((veh or {}).get("model"), (legacy or {}).get("model"))
    year = (veh or {}).get("year") or (legacy or {}).get("year") or ""

    # Prefer legacy for customer fields (that’s your old CSV)
    customer_name = first_truthy((legacy or {}).get("customer_name"), "—")
    status = first_truthy((legacy or {}).get("status"), (veh or {}).get("status"), "")
    notes = first_truthy((legacy or {}).get("notes"), (veh or {}).get("notes"), "")

    vehicle_nickname = first_truthy((legacy or {}).get("vehicle_nickname"), (veh or {}).get("nickname"), "")

    # Drive folder link: legacy first, then vehicles
    service_history_link = first_truthy((legacy or {}).get("service_history_link"), (veh or {}).get("service_history_link"), "")

    # Service history from jobs requires vehicle_id
    service_history = []
    if veh and veh.get("id"):
        service_history = build_history_from_jobs(veh["id"])

    return {
        "veh": veh or {},
        "legacy": legacy or {},
        "merged": {
            "vin": vin,
            "make": make,
            "model": model,
            "year": year,
            "status": status,
            "notes": notes,
            "vehicle_nickname": vehicle_nickname,
            "customer_name": customer_name,
            "service_history_link": service_history_link,
            "service_history": service_history,
        }
    }

# ============================================================
# Routes
# ============================================================
@app.route("/health")
def health():
    return jsonify({
        "ok": True,
        "supabase_ready": supabase_ready(),
        "db_path": DB_PATH,
        "supabase_url": SUPABASE_URL,
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

@app.route("/debug/supabase/vehicle/<vin>")
def debug_supabase_vehicle(vin):
    if not supabase_ready():
        return jsonify({"ok": False, "error": "Supabase not ready"}), 500
    try:
        veh = sb_vehicle_by_vin(vin)
        legacy = sb_legacy_by_vin(vin)
        merged = merged_profile_by_vin(vin)
        return jsonify({
            "ok": bool(veh or legacy),
            "vin": normalize_vin(vin),
            "vehicles_row": veh,
            "legacy_row": legacy,
            "merged": (merged or {}).get("merged") if merged else None
        }), (200 if (veh or legacy) else 404)
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

        m = data["merged"]
        legacy = data["legacy"]

        # Dashboard should populate like your original (includes customer fields + drive gallery)
        # If you want to hide phone/address/zip on dashboard later, we can blank them here.
        payload = {
            "customer_id": legacy.get("customer_id"),
            "customer_name": m.get("customer_name") or "—",
            "phone_number": legacy.get("phone_number") or "",
            "email": legacy.get("email") or "",
            "address": legacy.get("address") or "",
            "zip_code": legacy.get("zip_code") or "",
            "vehicle_nickname": m.get("vehicle_nickname") or "",
            "vin_number": m.get("vin") or vin,
            "make": m.get("make") or "",
            "model": m.get("model") or "",
            "year": m.get("year") or "",
            "status": m.get("status") or "",
            "notes": m.get("notes") or "",
            "service_history_link": m.get("service_history_link") or "",
            "service_history": m.get("service_history") or [],
            "access_token": (data["veh"] or {}).get("access_token"),
            "customer_portal_url": f"{request.host_url.rstrip('/')}/vin/{vin}",
        }
        return jsonify(payload)

    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/vin/<value>")
def public_report(value):
    """
    Public:
      - /vin/<VIN>   (17 chars) -> Supabase merge (vehicles + customer_data_legacy)
      - /vin/<TOKEN> (not 17)   -> SQLite token (legacy support)
    """
    value = (value or "").strip()

    # VIN route
    if len(value) == 17:
        vin = normalize_vin(value)

        if not supabase_ready():
            return render_template("public_report.html", not_found=True, vin=vin), 500

        try:
            data = merged_profile_by_vin(vin)
            if not data:
                return render_template("public_report.html", not_found=True, vin=vin), 404

            m = data["merged"]

            # PUBLIC MUST HIDE phone/address/zip always
            vehicle_for_template = {
                "vin_number": vin,
                "make": m.get("make") or "",
                "model": m.get("model") or "",
                "year": m.get("year") or "",
                "vehicle_nickname": m.get("vehicle_nickname") or "",
                "customer_name": "",  # hide
                "phone_number": "",   # hide
                "address": "",        # hide
                "zip_code": "",       # hide
                "status": "",         # optional hide
                "notes": m.get("notes") or "",
                "service_history_link": m.get("service_history_link") or "",
            }

            embed_url = drive_embed_from_folder(m.get("service_history_link") or "")

            return render_template(
                "public_report.html",
                not_found=False,
                vin=vin,
                vehicle=vehicle_for_template,
                service_history=m.get("service_history") or [],
                embed_url=embed_url
            )
        except Exception as e:
            return render_template("public_report.html", not_found=True, vin=vin), 500

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

    history = get_service_history_for_vin_sqlite(vin)
    embed_url = drive_embed_from_folder(vehicle.get("service_history_link"))

    return render_template(
        "public_report.html",
        not_found=False,
        vin=vin,
        vehicle=vehicle,
        service_history=history,
        embed_url=embed_url
    )

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=True)
