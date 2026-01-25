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
# Debug route: confirms WHICH app.py is running in Render/prod
# ============================================================
@app.route("/debug/sb/<vin>")
def debug_sb(vin):
    if not supabase_ready():
        return jsonify({
            "ok": False,
            "supabase_ready": False,
            "supabase_url": SUPABASE_URL,
        }), 500
    try:
        veh = supabase_get_vehicle_by_vin(vin)
        return jsonify({"ok": bool(veh), "vin": normalize_vin(vin), "vehicle": veh}), (200 if veh else 404)
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500

@app.route("/file")
def show_file():
    return jsonify({
        "running_file": __file__,
        "cwd": os.getcwd(),
    })

# ---------------------------
# SQLite (legacy) config
# ---------------------------
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "Customer_Data.db")

PUBLIC_BASE_URL = os.environ.get("PUBLIC_BASE_URL", "http://localhost:5000").rstrip("/")

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

# ============================================================
# SUPABASE helpers
# ============================================================
def _sb_get(path: str, params: dict):
    url = f"{SUPABASE_URL}/rest/v1/{path.lstrip('/')}"
    r = requests.get(url, headers=supabase_headers(), params=params, timeout=20)
    if r.status_code != 200:
        raise RuntimeError(f"Supabase GET {path} failed: {r.status_code} {r.text}")
    return r.json() or []

def supabase_get_vehicle_by_vin(vin: str):
    """
    Robust VIN lookup:
      - Works whether Supabase column is `vin` or `vin_number`
      - Uses PostgREST `or` syntax
      - Case-insensitive match via ilike
    """
    vin = normalize_vin(vin)

    # Try exact-ish match (ilike without wildcards behaves like case-insensitive exact)
    rows = _sb_get("vehicles", {
        "select": "id,vin,vin_number,year,make,model,trim",
        "or": f"(vin.ilike.{vin},vin_number.ilike.{vin})",
        "limit": "1",
    })
    if rows:
        return rows[0]

    # Fallback: handle accidental spaces/extra chars by using wildcard pattern
    rows = _sb_get("vehicles", {
        "select": "id,vin,vin_number,year,make,model,trim",
        "or": f"(vin.ilike.%{vin}%,vin_number.ilike.%{vin}%)",
        "limit": "1",
    })
    return rows[0] if rows else None

def supabase_get_latest_job_for_vehicle(vehicle_id: str):
    rows = _sb_get("jobs", {
        "select": "id,performed_at,notes,total_price_cents,customer_id,customers(id,full_name,phone)",
        "vehicle_id": f"eq.{vehicle_id}",
        "order": "performed_at.desc",
        "limit": "1",
    })
    return rows[0] if rows else None

def supabase_get_job_history(vehicle_id: str, limit: int = 25):
    return _sb_get("jobs", {
        "select": "id,performed_at,notes,total_price_cents",
        "vehicle_id": f"eq.{vehicle_id}",
        "order": "performed_at.desc",
        "limit": str(limit),
    })

def supabase_get_services_for_job(job_id: str):
    return _sb_get("job_services", {
        "select": "service_id,services(name,category)",
        "job_id": f"eq.{job_id}",
    })

def supabase_vehicle_payload(vin: str):
    """
    Payload for /search (dashboard).
    Requirement: hide phone/address/zip.
    """
    vin = normalize_vin(vin)
    veh = supabase_get_vehicle_by_vin(vin)
    if not veh:
        return None

    history_out = []
    try:
        jobs = supabase_get_job_history(veh["id"], limit=25)
        for j in jobs:
            service_label = ""
            try:
                js = supabase_get_services_for_job(j["id"])
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

    return {
        "customer_id": None,
        "customer_name": "—",

        # HIDE these always
        "phone_number": "",
        "address": "",
        "zip_code": "",

        "vehicle_nickname": "",
        "vin_number": veh.get("vin") or vin,
        "make": veh.get("make") or "",
        "model": veh.get("model") or "",
        "year": veh.get("year") or "",
        "status": "",
        "notes": "",
        "service_history_link": "",
        "service_history": history_out,

        "access_token": None,
        "customer_portal_url": f"{PUBLIC_BASE_URL}/vin/{vin}",
    }

def supabase_public_report_data_by_vin(vin: str):
    """
    Data for public_report.html.
    Requirement: hide phone/address/zip.
    """
    vin = normalize_vin(vin)
    veh = supabase_get_vehicle_by_vin(vin)
    if not veh:
        return None

    cust = {}
    try:
        latest = supabase_get_latest_job_for_vehicle(veh["id"])
        cust = (latest or {}).get("customers") or {}
    except Exception:
        cust = {}

    history_out = []
    try:
        jobs = supabase_get_job_history(veh["id"], limit=25)
        for j in jobs:
            service_label = ""
            try:
                js = supabase_get_services_for_job(j["id"])
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

    vehicle_for_template = {
        "vin_number": vin,
        "make": (veh.get("make") or ""),
        "model": (veh.get("model") or ""),
        "year": (veh.get("year") or ""),
        "vehicle_nickname": "",
        "customer_name": (cust.get("full_name") or ""),

        # HIDE these always
        "phone_number": "",
        "address": "",
        "zip_code": "",

        "status": "",
        "notes": "",
        "service_history_link": "",
    }

    return {
        "vin": vin,
        "vehicle": vehicle_for_template,
        "service_history": history_out,
        "embed_url": None,
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
        rows = _sb_get("vehicles", {"select": "vin", "limit": "1"})
        return jsonify({"ok": True, "status_code": 200, "body": rows}), 200
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500

@app.route("/health/public_vin/<vin>")
def health_public_vin(vin):
    try:
        if not supabase_ready():
            return jsonify({"ok": False, "error": "Supabase not ready"}), 500
        veh = supabase_get_vehicle_by_vin(vin)
        return jsonify({"ok": bool(veh), "vin": normalize_vin(vin), "vehicle": veh}), (200 if veh else 404)
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
    customer_portal_url = f"{PUBLIC_BASE_URL}/vin/{token}" if token else None

    return jsonify({
        "customer_id":            vehicle.get("customer_id"),
        "customer_name":          vehicle.get("customer_name") or "—",

        # HIDE
        "phone_number":           "",
        "address":                "",
        "zip_code":               "",

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
      - /vin/<VIN>   (17 chars) -> Supabase first (render even if jobs missing), fallback SQLite
      - /vin/<TOKEN> (not 17)   -> SQLite token (legacy)
    """
    value = (value or "").strip()

    # ----------------------------
    # VIN path (17 chars)
    # ----------------------------
    if len(value) == 17:
        vin = normalize_vin(value)

        # 1) Supabase first (DO NOT 404 just because jobs/history fails)
        if supabase_ready():
            try:
                veh = supabase_get_vehicle_by_vin(vin)
                if veh:
                    # Try to build history; if anything fails, just show empty history
                    data = None
                    try:
                        data = supabase_public_report_data_by_vin(vin)
                    except Exception as e:
                        print("Supabase public report history failed; rendering minimal:", str(e))

                    if not data:
                        # Minimal render (vehicle exists)
                        vehicle_for_template = {
                            "vin_number": vin,
                            "make": (veh.get("make") or ""),
                            "model": (veh.get("model") or ""),
                            "year": (veh.get("year") or ""),
                            "vehicle_nickname": "",
                            "customer_name": "",

                            # ALWAYS HIDE
                            "phone_number": "",
                            "address": "",
                            "zip_code": "",

                            "status": "",
                            "notes": "",
                            "service_history_link": "",
                        }
                        return render_template(
                            "public_report.html",
                            not_found=False,
                            vin=vin,
                            vehicle=vehicle_for_template,
                            service_history=[],
                            embed_url=None,
                        )

                    # Normal Supabase render
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

        # ALWAYS HIDE
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

    # ----------------------------
    # TOKEN path (legacy)
    # ----------------------------
    token = normalize_token(value)
    vehicle = get_vehicle_by_token_sqlite(token)
    if not vehicle:
        return render_template("public_report.html", not_found=True, vin="—"), 404

    vin = normalize_vin(vehicle.get("vin_number"))

    # ALWAYS HIDE
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
