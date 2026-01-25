from flask import Flask, request, jsonify, render_template
from flask_cors import CORS
import sqlite3
import os
import re
import secrets
import requests
from datetime import datetime
from functools import lru_cache

app = Flask(__name__, template_folder="templates", static_folder="../static")
CORS(app)

# ============================================================
# DEBUG: confirm which file is running in production
# ============================================================
APP_VERSION = "2026-01-25-supabase-public-report-v3"

@app.route("/version")
def version():
    return jsonify({
        "version": APP_VERSION,
        "running_file": __file__,
        "cwd": os.getcwd(),
    })

# ---------------------------
# SQLite (legacy) config
# ---------------------------
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "Customer_Data.db")

PUBLIC_BASE_URL = os.environ.get("PUBLIC_BASE_URL", "").strip().rstrip("/")
if not PUBLIC_BASE_URL:
    # safe default for local dev; prod uses request.host in templates anyway
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

def table_exists(table_name):
    con = get_db()
    cur = con.cursor()
    cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name=?", (table_name,))
    ok = cur.fetchone() is not None
    con.close()
    return ok

def column_exists(table_name, column_name):
    con = get_db()
    cur = con.cursor()
    try:
        cur.execute(f"PRAGMA table_info({table_name})")
        cols = [row[1] for row in cur.fetchall()]
        return column_name in cols
    finally:
        con.close()

def drive_embed_from_folder(url):
    if not url:
        return None
    m = re.search(r"/folders/([a-zA-Z0-9_\-]+)", url)
    if not m:
        return None
    fid = m.group(1)
    return f"https://drive.google.com/embeddedfolderview?id={fid}#grid"

def fmt_date(iso_str: str) -> str:
    if not iso_str:
        return ""
    try:
        s = iso_str.replace("Z", "+00:00")
        dt = datetime.fromisoformat(s)
        return dt.strftime("%#m/%#d/%Y") if os.name == "nt" else dt.strftime("%-m/%-d/%Y")
    except Exception:
        return iso_str

def _best_drive_link(*vals):
    """Return the first truthy value among candidates."""
    for v in vals:
        if v and str(v).strip():
            return str(v).strip()
    return ""

# ============================================================
# SQLITE (legacy)
# ============================================================
def get_vehicle_by_vin_sqlite(vin):
    vin = normalize_vin(vin)
    con = get_db()
    cur = con.cursor()
    cur.execute(
        """
        SELECT *
        FROM Customer_Data
        WHERE UPPER(TRIM(vin_number)) = ?
        LIMIT 1
        """,
        (vin,),
    )
    r = cur.fetchone()
    con.close()
    return dict(r) if r else None

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

def ensure_access_token_for_vin_sqlite(vin):
    vin = normalize_vin(vin)
    if not column_exists("Customer_Data", "access_token"):
        return None

    con = get_db()
    cur = con.cursor()
    cur.execute(
        """
        SELECT access_token
        FROM Customer_Data
        WHERE UPPER(TRIM(vin_number)) = ?
        LIMIT 1
        """,
        (vin,),
    )
    row = cur.fetchone()

    if not row:
        con.close()
        return None

    existing = (row["access_token"] or "").strip()
    if existing:
        con.close()
        return existing

    token = secrets.token_urlsafe(16).lower()
    cur.execute(
        """
        UPDATE Customer_Data
        SET access_token = ?
        WHERE UPPER(TRIM(vin_number)) = ?
        """,
        (token, vin),
    )
    con.commit()
    con.close()
    return token

def get_service_history_for_vin_sqlite(vin):
    if not table_exists("Service_History"):
        return []
    vin = normalize_vin(vin)
    con = get_db()
    cur = con.cursor()
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
        (vin,),
    )
    rows = [dict(r) for r in cur.fetchall()]
    con.close()
    return rows

def legacy_meta_for_vin(vin: str):
    """
    Pulls legacy fields that you still rely on (like Google Drive folder link)
    from SQLite, even when primary data is Supabase.
    """
    try:
        v = get_vehicle_by_vin_sqlite(vin)
        if not v:
            return {}
        return {
            "customer_name": v.get("customer_name") or "",
            "phone_number": v.get("phone_number") or "",
            "address": v.get("address") or "",
            "zip_code": v.get("zip_code") or "",
            "vehicle_nickname": v.get("vehicle_nickname") or "",
            "status": v.get("status") or "",
            "notes": v.get("notes") or "",
            "service_history_link": v.get("service_history_link") or "",
        }
    except Exception:
        return {}

# ============================================================
# SUPABASE (safe, schema-aware)
# ============================================================
def _sb_get_raw(path: str, params: dict):
    url = f"{SUPABASE_URL}/rest/v1/{path.lstrip('/')}"
    r = requests.get(url, headers=supabase_headers(), params=params, timeout=20)
    return r

def _parse_missing_column(msg: str):
    """
    Supabase/PostgREST missing column error often looks like:
      {"code":"42703","message":"column vehicles.vin_number does not exist", ...}
    We extract 'vin_number' (or whatever) so we can retry without it.
    """
    if not msg:
        return None
    m = re.search(r"column\s+[a-zA-Z0-9_]+\.(\w+)\s+does not exist", msg)
    return m.group(1) if m else None

@lru_cache(maxsize=256)
def sb_has_column(table: str, col: str) -> bool:
    """
    Probe if a column exists by selecting it. Cache result.
    """
    if not supabase_ready():
        return False
    r = _sb_get_raw(table, {"select": col, "limit": "1"})
    if r.status_code == 200:
        return True
    missing = _parse_missing_column(r.text or "")
    if missing == col:
        return False
    # For any other failure (permissions, etc) treat as not available
    return False

def sb_safe_select(table: str, desired_cols: list[str], extra_params: dict):
    """
    Select only columns that exist.
    """
    cols = []
    for c in desired_cols:
        if sb_has_column(table, c):
            cols.append(c)
    # fallback to minimal
    if not cols:
        cols = ["id"]
    params = {"select": ",".join(cols), **(extra_params or {})}
    r = _sb_get_raw(table, params)
    if r.status_code != 200:
        raise RuntimeError(f"Supabase GET {table} failed: {r.status_code} {r.text}")
    return r.json() or [], cols

def supabase_get_vehicle_by_vin(vin: str):
    """
    Robust VIN lookup:
      - Uses vin column for sure
      - Uses vin_number only if it exists
      - Case-insensitive matching via ilike if supported
    """
    vin = normalize_vin(vin)

    # Determine available columns for matching
    has_vin = sb_has_column("vehicles", "vin")
    has_vin_number = sb_has_column("vehicles", "vin_number")

    if not has_vin and not has_vin_number:
        raise RuntimeError("Supabase vehicles table has no vin/vin_number column")

    # Build filter safely (do NOT reference a column that doesn't exist)
    if has_vin and has_vin_number:
        # try ilike exact-ish first
        params = {
            "select": "*",
            "or": f"(vin.ilike.{vin},vin_number.ilike.{vin})",
            "limit": "1",
        }
        r = _sb_get_raw("vehicles", params)
        if r.status_code == 200:
            rows = r.json() or []
            if rows:
                return rows[0]
        # wildcard fallback
        params = {
            "select": "*",
            "or": f"(vin.ilike.%{vin}%,vin_number.ilike.%{vin}%)",
            "limit": "1",
        }
        r = _sb_get_raw("vehicles", params)
        if r.status_code != 200:
            raise RuntimeError(f"Supabase GET vehicles failed: {r.status_code} {r.text}")
        rows = r.json() or []
        return rows[0] if rows else None

    # Only vin exists
    if has_vin:
        # ilike exact-ish
        r = _sb_get_raw("vehicles", {"select": "*", "vin": f"ilike.{vin}", "limit": "1"})
        if r.status_code != 200:
            raise RuntimeError(f"Supabase GET vehicles failed: {r.status_code} {r.text}")
        rows = r.json() or []
        if rows:
            return rows[0]
        # wildcard fallback
        r = _sb_get_raw("vehicles", {"select": "*", "vin": f"ilike.%{vin}%", "limit": "1"})
        if r.status_code != 200:
            raise RuntimeError(f"Supabase GET vehicles failed: {r.status_code} {r.text}")
        rows = r.json() or []
        return rows[0] if rows else None

    # Only vin_number exists
    r = _sb_get_raw("vehicles", {"select": "*", "vin_number": f"ilike.{vin}", "limit": "1"})
    if r.status_code != 200:
        raise RuntimeError(f"Supabase GET vehicles failed: {r.status_code} {r.text}")
    rows = r.json() or []
    if rows:
        return rows[0]
    r = _sb_get_raw("vehicles", {"select": "*", "vin_number": f"ilike.%{vin}%", "limit": "1"})
    if r.status_code != 200:
        raise RuntimeError(f"Supabase GET vehicles failed: {r.status_code} {r.text}")
    rows = r.json() or []
    return rows[0] if rows else None

def supabase_get_job_history(vehicle_id: str, limit: int = 25):
    rows, _ = sb_safe_select(
        "jobs",
        desired_cols=["id", "performed_at", "notes", "total_price_cents", "vehicle_id", "customer_id"],
        extra_params={
            "vehicle_id": f"eq.{vehicle_id}",
            "order": "performed_at.desc",
            "limit": str(limit),
        },
    )
    return rows

def supabase_get_services_for_job(job_id: str):
    # job_services has service_id, job_id, and nested services(name,category)
    # we can't probe nested columns easily, so keep select minimal + nested
    r = _sb_get_raw("job_services", {
        "select": "service_id,services(name,category)",
        "job_id": f"eq.{job_id}",
    })
    if r.status_code != 200:
        # If RLS blocks this table, don’t crash the whole page
        return []
    return r.json() or []

def supabase_get_latest_job_with_customer(vehicle_id: str):
    """
    Try to grab the latest job and join customers if your schema supports it.
    If join fails (RLS or missing relationship), return None safely.
    """
    r = _sb_get_raw("jobs", {
        "select": "id,performed_at,notes,total_price_cents,customer_id,customers(id,full_name,phone,address,zip_code)",
        "vehicle_id": f"eq.{vehicle_id}",
        "order": "performed_at.desc",
        "limit": "1",
    })
    if r.status_code != 200:
        return None
    rows = r.json() or []
    return rows[0] if rows else None

def supabase_vehicle_payload(vin: str):
    """
    Payload for /search (internal dashboard).
    - Uses Supabase for vehicle + service history
    - Backfills gallery link + misc fields from legacy SQLite if not in Supabase yet
    """
    vin = normalize_vin(vin)
    veh = supabase_get_vehicle_by_vin(vin)
    if not veh:
        return None

    # Legacy fallback (for drive folder link, notes, etc.)
    legacy = legacy_meta_for_vin(vin)

    # Pull customer info if join works; otherwise legacy may still have it
    cust = {}
    latest = None
    try:
        latest = supabase_get_latest_job_with_customer(veh.get("id"))
        cust = (latest or {}).get("customers") or {}
    except Exception:
        cust = {}

    history_out = []
    try:
        jobs = supabase_get_job_history(veh.get("id"), limit=25)
        for j in jobs:
            service_label = ""
            try:
                js = supabase_get_services_for_job(j.get("id"))
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

            history_out.append({
                "date": fmt_date(j.get("performed_at")),
                "service_type": service_label or "",
                "service_notes": (j.get("notes") or ""),
                "next_recommended_service": "",
                "photos_link": "",
                "technician": "",
                "price": "",
                "customer_feedback": "",
            })
    except Exception:
        history_out = []

    # Service gallery link: prefer Supabase columns if present, else legacy SQLite
    drive_link = _best_drive_link(
        veh.get("service_history_link"),
        veh.get("photos_link"),
        veh.get("drive_folder_url"),
        veh.get("gallery_url"),
        legacy.get("service_history_link"),
    )

    payload = {
        "customer_id": cust.get("id") or latest.get("customer_id") if isinstance(latest, dict) else None,
        "customer_name": cust.get("full_name") or legacy.get("customer_name") or "—",

        # INTERNAL dashboard can show these (public route will always hide)
        "phone_number": cust.get("phone") or legacy.get("phone_number") or "",
        "address": cust.get("address") or legacy.get("address") or "",
        "zip_code": cust.get("zip_code") or legacy.get("zip_code") or "",

        "vehicle_nickname": legacy.get("vehicle_nickname") or "",
        "vin_number": veh.get("vin") or veh.get("vin_number") or vin,
        "make": veh.get("make") or "",
        "model": veh.get("model") or "",
        "year": veh.get("year") or "",
        "status": legacy.get("status") or "",
        "notes": legacy.get("notes") or "",
        "service_history_link": drive_link,
        "service_history": history_out,

        "access_token": None,
        "customer_portal_url": f"{PUBLIC_BASE_URL.rstrip('/')}/vin/{vin}",
    }
    return payload

def supabase_public_report_data_by_vin(vin: str):
    """
    Data for public_report.html (PUBLIC).
    Requirement: ALWAYS hide phone/address/zip.
    Also backfill service_history_link from legacy SQLite if not migrated yet.
    """
    vin = normalize_vin(vin)
    veh = supabase_get_vehicle_by_vin(vin)
    if not veh:
        return None

    legacy = legacy_meta_for_vin(vin)

    history_out = []
    try:
        jobs = supabase_get_job_history(veh.get("id"), limit=25)
        for j in jobs:
            service_label = ""
            try:
                js = supabase_get_services_for_job(j.get("id"))
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

            history_out.append({
                "date": fmt_date(j.get("performed_at")),
                "service_type": service_label or "",
                "service_notes": (j.get("notes") or ""),
                "next_recommended_service": "",
                "photos_link": "",
                "technician": "",
                "price": "",
                "customer_feedback": "",
            })
    except Exception:
        history_out = []

    # Gallery link
    drive_link = _best_drive_link(
        veh.get("service_history_link"),
        veh.get("photos_link"),
        veh.get("drive_folder_url"),
        veh.get("gallery_url"),
        legacy.get("service_history_link"),
    )

    embed_url = drive_embed_from_folder(drive_link) if drive_link else None

    vehicle_for_template = {
        "vin_number": vin,
        "make": (veh.get("make") or ""),
        "model": (veh.get("model") or ""),
        "year": (veh.get("year") or ""),
        "vehicle_nickname": legacy.get("vehicle_nickname") or "",
        "customer_name": "",  # PUBLIC: do not show

        # ALWAYS HIDE
        "phone_number": "",
        "address": "",
        "zip_code": "",

        "status": "",
        "notes": legacy.get("notes") or "",
        "service_history_link": drive_link or "",
    }

    return {
        "vin": vin,
        "vehicle": vehicle_for_template,
        "service_history": history_out,
        "embed_url": embed_url,
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
        r = _sb_get_raw("vehicles", {"select": "vin", "limit": "1"})
        try:
            body = r.json()
        except Exception:
            body = r.text
        return jsonify({"ok": r.status_code == 200, "status_code": r.status_code, "body": body}), (200 if r.status_code == 200 else 500)
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500

@app.route("/debug/supabase/vehicle/<vin>")
def debug_supabase_vehicle(vin):
    if not supabase_ready():
        return jsonify({"ok": False, "error": "Supabase not ready"}), 500
    try:
        veh = supabase_get_vehicle_by_vin(vin)
        return jsonify({"ok": bool(veh), "vin": normalize_vin(vin), "vehicle": veh}), (200 if veh else 404)
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500

@app.route("/debug/supabase/probe")
def debug_supabase_probe():
    """
    Shows which optional columns exist on vehicles and jobs.
    Helps you finish migrating drive links into Supabase.
    """
    if not supabase_ready():
        return jsonify({"ok": False, "error": "Supabase not ready"}), 500

    candidates = [
        "vin", "vin_number", "year", "make", "model", "trim",
        "service_history_link", "photos_link", "drive_folder_url", "gallery_url"
    ]
    vehicles_cols = {c: sb_has_column("vehicles", c) for c in candidates}
    jobs_cols = {c: sb_has_column("jobs", c) for c in ["id", "performed_at", "notes", "total_price_cents", "vehicle_id", "customer_id"]}

    return jsonify({
        "ok": True,
        "vehicles_columns": vehicles_cols,
        "jobs_columns": jobs_cols,
    })

@app.route("/")
def home():
    return render_template("index.html")

@app.route("/search", methods=["GET"])
def search():
    vin = normalize_vin(request.args.get("vin"))
    if len(vin) != 17:
        return jsonify({"error": "VIN must be 17 characters."}), 400

    # 1) Supabase first
    if supabase_ready():
        try:
            payload = supabase_vehicle_payload(vin)
            if payload:
                return jsonify(payload)
            return jsonify({"error": "Vin not found."}), 404
        except Exception as e:
            print("Supabase error, falling back to SQLite:", str(e))

    # 2) SQLite fallback
    vehicle = get_vehicle_by_vin_sqlite(vin)
    if not vehicle:
        return jsonify({"error": "Vin not found."}), 404

    history = get_service_history_for_vin_sqlite(vin)
    token = ensure_access_token_for_vin_sqlite(vin)
    customer_portal_url = f"{PUBLIC_BASE_URL.rstrip('/')}/vin/{vin}"

    return jsonify({
        "customer_id":            vehicle.get("customer_id"),
        "customer_name":          vehicle.get("customer_name") or "—",
        "phone_number":           vehicle.get("phone_number") or "",
        "address":                vehicle.get("address") or "",
        "zip_code":               vehicle.get("zip_code") or "",
        "vehicle_nickname":       vehicle.get("vehicle_nickname") or "",
        "vin_number":             vehicle.get("vin_number") or vin,
        "make":                   vehicle.get("make") or "",
        "model":                  vehicle.get("model") or "",
        "year":                   vehicle.get("year") or "",
        "status":                 vehicle.get("status") or "",
        "notes":                  vehicle.get("notes") or "",
        "service_history_link":   vehicle.get("service_history_link") or "",
        "service_history":        history,
        "access_token":           token,
        "customer_portal_url":    customer_portal_url,
    })

@app.route("/vin/<value>")
def public_report(value):
    """
    Public:
      - /vin/<VIN>   (17 chars) -> Supabase first, fallback SQLite
      - /vin/<TOKEN> (not 17)   -> SQLite token (legacy)
    """
    value = (value or "").strip()

    # VIN path
    if len(value) == 17:
        vin = normalize_vin(value)

        # 1) Supabase first
        if supabase_ready():
            try:
                data = supabase_public_report_data_by_vin(vin)
                if data:
                    return render_template(
                        "public_report.html",
                        not_found=False,
                        vin=data["vin"],
                        vehicle=data["vehicle"],
                        service_history=data["service_history"],
                        embed_url=data["embed_url"],
                    )
            except Exception as e:
                print("Supabase public_report error, falling back to SQLite:", str(e))

        # 2) SQLite fallback
        vehicle = get_vehicle_by_vin_sqlite(vin)
        if not vehicle:
            return render_template("public_report.html", not_found=True, vin=vin), 404

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

    # TOKEN path (legacy)
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
