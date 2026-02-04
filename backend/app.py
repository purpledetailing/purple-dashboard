from flask import Flask, request, jsonify, render_template
from flask_cors import CORS
import sqlite3
import os
import re
import requests
from datetime import datetime

app = Flask(__name__, template_folder="templates", static_folder="../static")
CORS(app)

# ============================================================
# DEBUG
# ============================================================
APP_VERSION = "2026-02-01-supabase-legacy-merge-v6-FIXED"

@app.route("/version")
def version():
    return jsonify({
        "version": APP_VERSION,
        "running_file": __file__,
        "cwd": os.getcwd(),
    })

# ---------------------------
# SQLite
# ---------------------------
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "Customer_Data.db")

PUBLIC_BASE_URL = os.environ.get("PUBLIC_BASE_URL", "").strip().rstrip("/")
if not PUBLIC_BASE_URL:
    PUBLIC_BASE_URL = "http://localhost:5000"

# ---------------------------
# Supabase config (FIXED)
# ---------------------------
USE_SUPABASE = os.environ.get("USE_SUPABASE", "1").strip() == "1"

# 🔧 FIX: allow Next.js-style env var
SUPABASE_URL = (
    os.environ.get("SUPABASE_URL")
    or os.environ.get("NEXT_PUBLIC_SUPABASE_URL")
    or ""
).rstrip("/")

SUPABASE_SERVICE_ROLE_KEY = (
    os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or ""
).strip()

LEGACY_TABLE = os.environ.get("LEGACY_TABLE", "customer_data_legacy").strip()
PHOTO_BUCKET = os.environ.get("PHOTO_BUCKET", "vehicle-photos")

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
VIN_RE = re.compile(r"^[A-HJ-NPR-Z0-9]{17}$")

def normalize_vin(vin: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", (vin or "").strip().upper())

def is_valid_vin(vin: str) -> bool:
    return bool(VIN_RE.match(vin or ""))

def get_db():
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    return con

def fmt_date(iso_str: str) -> str:
    if not iso_str:
        return ""
    try:
        s = str(iso_str).replace("Z", "+00:00")
        dt = datetime.fromisoformat(s)
        return dt.strftime("%-m/%-d/%Y") if os.name != "nt" else dt.strftime("%#m/%#d/%Y")
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

# ---------------------------
# Supabase REST helpers
# ---------------------------
def sb_get(path: str, params: dict, timeout: int = 20):
    url = f"{SUPABASE_URL}/rest/v1/{path.lstrip('/')}"
    r = requests.get(url, headers=supabase_headers(), params=params, timeout=timeout)
    if r.status_code != 200:
        raise RuntimeError(f"Supabase GET {path} failed: {r.status_code} {r.text}")
    return r.json() or []

# ---------------------------
# Supabase Storage helpers (FIXED)
# ---------------------------
def sb_list_and_sign_photos(vin: str, limit: int = 50):
    """List photos from bucket VIN/ and return signed URLs"""
    vin = normalize_vin(vin)
    urls = []

    try:
        list_url = f"{SUPABASE_URL}/storage/v1/object/list/{PHOTO_BUCKET}"
        r = requests.post(
            list_url,
            headers=supabase_headers(),
            json={"prefix": f"{vin}/"},
            timeout=20
        )
        if r.status_code != 200:
            return []

        files = r.json() or []
        for f in files[:limit]:
            name = f.get("name")
            if not name:
                continue

            sign_url = f"{SUPABASE_URL}/storage/v1/object/sign/{PHOTO_BUCKET}/{vin}/{name}"
            sr = requests.post(
                sign_url,
                headers=supabase_headers(),
                json={"expiresIn": 3600},
                timeout=20
            )
            if sr.status_code == 200:
                signed = sr.json().get("signedURL") or sr.json().get("signedUrl")
                if signed:
                    urls.append(
                        signed if signed.startswith("http") else f"{SUPABASE_URL}{signed}"
                    )
    except Exception:
        return []

    return urls

# ============================================================
# Routes
# ============================================================
@app.route("/health")
def health():
    return jsonify({
        "ok": True,
        "supabase_ready": supabase_ready(),
        "supabase_url": SUPABASE_URL,
        "photo_bucket": PHOTO_BUCKET,
    })

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

        m = data.get("merged") or {}
        legacy = data.get("legacy") or {}

        # 🔧 FIX: Ensure frontend always receives photo_urls
        photo_urls = m.get("photo_urls") or []

        payload = {
            "customer_id": legacy.get("customer_id"),
            "customer_name": m.get("customer_name") or legacy.get("customer_name") or "—",
            "phone_number": m.get("phone_number") or legacy.get("phone_number") or "",
            "email": legacy.get("email") or m.get("email") or "",
            "address": legacy.get("address") or "",
            "zip_code": legacy.get("zip_code") or "",
            "vehicle_nickname": m.get("vehicle_nickname") or legacy.get("vehicle_nickname") or "",
            "vin_number": m.get("vin") or vin,
            "make": m.get("make") or legacy.get("make") or "",
            "model": m.get("model") or legacy.get("model") or "",
            "year": m.get("year") or legacy.get("year") or "",
            "status": m.get("status") or legacy.get("status") or "",
            "notes": m.get("notes") or legacy.get("notes") or "",
            "photo_count": len(photo_urls),
            "photo_urls": photo_urls, # ✅ REQUIRED: frontend expects this
            "service_history": m.get("service_history") or [],
            "access_token": (data.get("veh") or {}).get("access_token"),
            "customer_portal_url": f"{request.host_url.rstrip('/')}/vin/{vin}",
        }

        return jsonify(payload), 200

    except Exception as e:
        return jsonify({"error": str(e)}), 500

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=True)
