import os
import traceback
from datetime import datetime

from flask import Flask, jsonify, request, Response
from flask_cors import CORS

from supabase import create_client, Client


# -----------------------------
# Config
# -----------------------------
SUPABASE_URL = os.environ.get("SUPABASE_URL") or os.environ.get("NEXT_PUBLIC_SUPABASE_URL") or ""
SUPABASE_SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or os.environ.get("SUPABASE_KEY") or ""

if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
    # Do not crash import-time in prod; allow app to boot and show debug errors.
    print("⚠️ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables.")

supabase: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

app = Flask(__name__)
CORS(app)


# -----------------------------
# Helpers
# -----------------------------
def normalize_vin(v: str) -> str:
    return (v or "").strip().upper()

def is_valid_vin(v: str) -> bool:
    # Basic VIN validation (no I/O/Q)
    import re
    return bool(re.match(r"^[A-HJ-NPR-Z0-9]{17}$", v or ""))

def pick_first(row: dict, keys: list, default="—"):
    for k in keys:
        if k in row and row[k] not in (None, ""):
            return row[k]
    return default

def safe_date(val):
    if not val:
        return ""
    # Supabase may return ISO strings
    try:
        if isinstance(val, str):
            # keep only date part if timestamp
            return val.split("T")[0]
        if isinstance(val, datetime):
            return val.date().isoformat()
    except Exception:
        pass
    return str(val)

def make_history_entry_from_job(job_row: dict) -> dict:
    return {
        "date": safe_date(pick_first(job_row, ["date", "service_date", "created_at"], "")),
        "service_type": pick_first(job_row, ["service_name", "service_type", "job_type", "package_name", "work_done"], "—"),
        "service_description": pick_first(job_row, ["service_description", "description", "details"], ""),
        "service_notes": pick_first(job_row, ["notes", "service_notes"], "—"),
        "next_recommended_service": pick_first(job_row, ["next_recommended_service", "next_service", "next"], "—"),
        "source": "customer_jobs_legacy",
    }

def make_history_entry_from_customer_legacy(row: dict) -> dict:
    # customer_data_legacy has: vin, created_at, work_done (from your screenshot), maybe notes
    return {
        "date": safe_date(pick_first(row, ["service_date", "date", "created_at"], "")),
        "service_type": pick_first(row, ["work_done", "service_name", "service_type"], "—"),
        "service_description": pick_first(row, ["service_description", "description"], ""),
        "service_notes": pick_first(row, ["notes", "service_notes"], "—"),
        "next_recommended_service": pick_first(row, ["next_recommended_service", "next_service", "next"], "—"),
        "source": "customer_data_legacy",
    }


# -----------------------------
# Serve the dashboard at /
# -----------------------------
@app.get("/")
def home():
    # Serve local file if present; otherwise show a helpful message.
    # Put index.html in the same folder as app.py.
    try:
        here = os.path.dirname(os.path.abspath(__file__))
        path = os.path.join(here, "index.html")
        if os.path.exists(path):
            with open(path, "r", encoding="utf-8") as f:
                return Response(f.read(), mimetype="text/html")
        return Response(
            "<h1>Purple Dashboard</h1><p>index.html not found next to app.py</p>",
            mimetype="text/html",
        )
    except Exception as e:
        tb = traceback.format_exc()
        print("🔥 ERROR in / route:", str(e))
        print(tb)
        if request.args.get("debug") == "1":
            return Response(f"<pre>{tb}</pre>", mimetype="text/html", status=500)
        return Response("Internal Server Error", mimetype="text/html", status=500)


# -----------------------------
# API: VIN Search
# -----------------------------
@app.get("/search")
def search():
    try:
        vin = normalize_vin(request.args.get("vin", ""))
        if not is_valid_vin(vin):
            return jsonify({"error": "Please provide a valid 17-character VIN."}), 400

        # ---------------------------------------
        # 1) Customer record: customer_data_legacy
        # ---------------------------------------
        # We pull the most recent row for the VIN
        cust_resp = (
            supabase.table("customer_data_legacy")
            .select("*")
            .eq("vin", vin)
            .order("created_at", desc=True)
            .limit(1)
            .execute()
        )
        cust_rows = cust_resp.data or []
        customer = cust_rows[0] if cust_rows else {}

        if not customer:
            # If you also have a newer "customers" table, you can add another fallback here.
            return jsonify({"error": "VIN not found."}), 404

        # Map customer fields (use multiple possible column names safely)
        payload = {
            "vin_number": vin,
            "customer_name": pick_first(customer, ["customer_name", "name", "full_name"], "—"),
            "phone_number": pick_first(customer, ["phone_number", "phone", "mobile"], "—"),
            "address": pick_first(customer, ["address", "street_address", "addr"], "—"),
            "zip_code": pick_first(customer, ["zip_code", "zip", "postal_code"], "—"),
            "email": pick_first(customer, ["email", "email_address"], ""),
            "vehicle_nickname": pick_first(customer, ["vehicle_nickname", "vehicle_name"], ""),
            "make": pick_first(customer, ["make"], "—"),
            "model": pick_first(customer, ["model"], "—"),
            "year": pick_first(customer, ["year"], "—"),
            "status": pick_first(customer, ["status"], ""),
            "notes": pick_first(customer, ["notes", "customer_notes"], ""),
            "photo_urls": [],
            "service_history": [],
        }

        # ---------------------------------------
        # 2) Photos: try common tables/columns
        # ---------------------------------------
        photo_urls = []

        # Try: vehicle_photos table (common)
        try:
            pr = (
                supabase.table("vehicle_photos")
                .select("*")
                .eq("vin", vin)
                .order("created_at", desc=True)
                .limit(100)
                .execute()
            )
            for r in (pr.data or []):
                # try common fields
                u = pick_first(r, ["photo_url", "url", "public_url", "signed_url"], "")
                if u and u != "—":
                    photo_urls.append(u)
        except Exception:
            pass

        # Try: legacy_photos / public_vehicle_photos (if you had it)
        if not photo_urls:
            for tbl in ["public_vehicle_photos", "legacy_photos"]:
                try:
                    pr2 = (
                        supabase.table(tbl)
                        .select("*")
                        .eq("vin", vin)
                        .order("created_at", desc=True)
                        .limit(100)
                        .execute()
                    )
                    for r in (pr2.data or []):
                        u = pick_first(r, ["photo_url", "url", "public_url", "signed_url"], "")
                        if u and u != "—":
                            photo_urls.append(u)
                except Exception:
                    continue

        payload["photo_urls"] = photo_urls

        # ---------------------------------------
        # 3) Service History: customer_jobs_legacy (PRIMARY)
        # ---------------------------------------
        jobs_history = []
        try:
            jobs_resp = (
                supabase.table("customer_jobs_legacy")
                .select("*")
                .eq("vin", vin)
                .order("created_at", desc=True)
                .limit(50)
                .execute()
            )
            for job in (jobs_resp.data or []):
                jobs_history.append(make_history_entry_from_job(job))
        except Exception as e:
            # Don't fail the whole search if this table isn't present
            print("⚠️ Could not read customer_jobs_legacy:", str(e))

        # ---------------------------------------
        # 4) Fallback: customer_data_legacy.work_done (if no jobs found)
        # ---------------------------------------
        if not jobs_history:
            try:
                legacy_rows_resp = (
                    supabase.table("customer_data_legacy")
                    .select("*")
                    .eq("vin", vin)
                    .order("created_at", desc=True)
                    .limit(50)
                    .execute()
                )
                legacy_rows = legacy_rows_resp.data or []
                for r in legacy_rows:
                    work_done = pick_first(r, ["work_done"], "")
                    if work_done and work_done != "—":
                        jobs_history.append(make_history_entry_from_customer_legacy(r))
            except Exception as e:
                print("⚠️ Could not build fallback history from customer_data_legacy:", str(e))

        payload["service_history"] = jobs_history

        return jsonify(payload), 200

    except Exception as e:
        tb = traceback.format_exc()
        print("🔥 ERROR in /search route:", str(e))
        print(tb)

        if request.args.get("debug") == "1":
            return Response(f"<pre>{tb}</pre>", mimetype="text/html", status=500)

        return jsonify({"error": "Internal Server Error"}), 500


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5000"))
    app.run(host="0.0.0.0", port=port, debug=False) 
