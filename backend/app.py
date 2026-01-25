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

# ---------------------------
# SQLite (legacy) config
# ---------------------------
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "Customer_Data.db")

PUBLIC_BASE_URL = os.environ.get("PUBLIC_BASE_URL", "http://localhost:5000").rstrip("/")

# ---------------------------
# Supabase config (NEW)
# ---------------------------
USE_SUPABASE = os.environ.get("USE_SUPABASE", "1").strip() == "1"
SUPABASE_URL = (os.environ.get("SUPABASE_URL") or "").rstrip("/")
SUPABASE_SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or ""

def supabase_headers():
    # IMPORTANT: Supabase REST requires both apikey + Authorization
    return {
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
        "Content-Type": "application/json",
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
# SUPABASE
# ============================================================
def supabase_get_vehicle_by_vin(vin: str):
    """
    Pull from public.vehicles by VIN.
    NOTE: we make it case-insensitive by normalizing VIN and querying exact match.
    """
    vin = normalize_vin(vin)
    url = f"{SUPABASE_URL}/rest/v1/vehicles"
    params = {
        "select": "id,vin,year,make,model,trim",
        "vin": f"eq.{vin}",
        "limit": "1",
    }
    r = requests.get(url, headers=supabase_headers(), params=params, timeout=15)
    if r.status_code != 200:
        raise RuntimeError(f"Supabase vehicles query failed: {r.status_code} {r.text}")
    data = r.json()
    return data[0] if data else None

def supabase_vehicle_payload(vin: str):
    """
    Minimal payload matching the dashboard keys.
    """
    vin = normalize_vin(vin)
    veh = supabase_get_vehicle_by_vin(vin)
    if not veh:
        return None

    return {
        "customer_id": None,
        "customer_name": "",
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
        "service_history": [],
        "access_token": None,
        "customer_portal_url": f"{PUBLIC_BASE_URL}/vin/{vin}",
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
    """
    Quick probe to confirm prod can reach Supabase.
    """
    try:
        if not supabase_ready():
            return jsonify({
                "ok": False,
                "error": "Supabase env vars not set",
                "supabase_url": SUPABASE_URL
            }), 500

        url = f"{SUPABASE_URL}/rest/v1/vehicles"
        params = {"select": "vin", "limit": "1"}
        r = requests.get(url, headers=supabase_headers(), params=params, timeout=15)

        # try json safely
        try:
            body = r.json()
        except Exception:
            body = r.text

        return jsonify({
            "ok": r.status_code == 200,
            "status_code": r.status_code,
            "body": body
        }), (200 if r.status_code == 200 else 500)

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
        "customer_name":          vehicle.get("customer_name"),
        "phone_number":           vehicle.get("phone_number"),
        "address":                vehicle.get("address"),
        "zip_code":               vehicle.get("zip_code"),
        "vehicle_nickname":       vehicle.get("vehicle_nickname"),
        "vin_number":             vehicle.get("vin_number"),
        "make":                   vehicle.get("make"),
        "model":                  vehicle.get("model"),
        "year":                   vehicle.get("year"),
        "status":                 vehicle.get("status"),
        "notes":                  vehicle.get("notes"),
        "service_history_link":   vehicle.get("service_history_link"),
        "service_history":        history,
        "access_token":           token,
        "customer_portal_url":    customer_portal_url,
    })

@app.route("/vin/<value>")
def public_report(value):
    # Keep public report on SQLite for now
    value = (value or "").strip()
    vehicle = None
    vin = "—"

    if len(value) == 17:
        vin = normalize_vin(value)
        vehicle = get_vehicle_by_vin_sqlite(vin)
    else:
        token = normalize_token(value)
        vehicle = get_vehicle_by_token_sqlite(token)
        if vehicle:
            vin = normalize_vin(vehicle.get("vin_number"))

    if not vehicle:
        return render_template("public_report.html", not_found=True, vin=vin if vin else "—"), 404

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
