from flask import Flask, request, jsonify, render_template
from flask_cors import CORS
import sqlite3
import os
import re

app = Flask(__name__, template_folder="templates", static_folder="../static")
CORS(app)

# Always resolve DB path from this file location (avoids “wrong DB” issues)
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "Customer_Data.db")


def get_db():
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    return con


def normalize_vin(vin: str) -> str:
    """Uppercase + trim, safe for None."""
    return (vin or "").strip().upper()


def table_exists(table_name):
    con = get_db()
    cur = con.cursor()
    cur.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
        (table_name,),
    )
    ok = cur.fetchone() is not None
    con.close()
    return ok


def get_vehicle_by_vin(vin):
    """VIN lookup from Customer_Data using TRIM/UPPER to avoid hidden spaces/case issues."""
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


def get_service_history_for_vin(vin):
    """Safely read Service_History if it exists; else return empty list."""
    if not table_exists("Service_History"):
        return []

    vin = normalize_vin(vin)

    con = get_db()
    cur = con.cursor()
    cur.execute(
        """
        SELECT
          COALESCE(date, '')                    AS date,
          COALESCE(service_type, '')            AS service_type,
          COALESCE(service_notes, '')           AS service_notes,
          COALESCE(next_recommended_service, '') AS next_recommended_service,
          COALESCE(photos_link, '')             AS photos_link,
          COALESCE(technician, '')              AS technician,
          COALESCE(price, '')                   AS price,
          COALESCE(customer_feedback, '')       AS customer_feedback
        FROM Service_History
        WHERE UPPER(TRIM(vehicle_vin)) = ?
        ORDER BY date DESC
        """,
        (vin,),
    )
    rows = [dict(r) for r in cur.fetchall()]
    con.close()
    return rows


def drive_embed_from_folder(url):
    """
    Convert a Google Drive 'folders/<id>' URL -> embedded grid URL.
    Returns None if not parsable.
    """
    if not url:
        return None
    m = re.search(r"/folders/([a-zA-Z0-9_\-]+)", url)
    if not m:
        return None
    fid = m.group(1)
    return f"https://drive.google.com/embeddedfolderview?id={fid}#grid"


# ---------------------------
# Internal dashboard routes
# ---------------------------

@app.route("/")
def home():
    return render_template("index.html")


@app.route("/customers")
def customers():
    """Simple JSON list (for sanity checks)."""
    con = get_db()
    cur = con.cursor()
    cur.execute(
        """
        SELECT customer_id, customer_name, vin_number, make, model, year
        FROM Customer_Data
        LIMIT 50
        """
    )
    data = [dict(r) for r in cur.fetchall()]
    con.close()
    return jsonify({"customers": data})


@app.route("/search", methods=["GET"])
def search():
    """Internal VIN search used by dashboard (expects full 17-char VIN)."""
    vin = normalize_vin(request.args.get("vin"))

    if len(vin) != 17:
        return jsonify({"error": "VIN must be 17 characters."}), 400

    vehicle = get_vehicle_by_vin(vin)
    if not vehicle:
        return jsonify({"error": "Vin not found."}), 404

    history = get_service_history_for_vin(vin)

    # shape the response (your internal dashboard payload)
    vehicle_out = {
        "customer_id":            vehicle.get("customer_id"),
        "customer_name":          vehicle.get("customer_name"),
        "phone_number":           vehicle.get("phone_number"),
        "address":                vehicle.get("address"),
        "zip_code":               vehicle.get("zip_code"),
        "vehicle_nickname":       vehicle.get("vehicle_nickname"),  # internal can keep it
        "vin_number":             vehicle.get("vin_number"),
        "make":                   vehicle.get("make"),
        "model":                  vehicle.get("model"),
        "year":                   vehicle.get("year"),
        "status":                 vehicle.get("status"),
        "notes":                  vehicle.get("notes"),
        "service_history_link":   vehicle.get("service_history_link"),
        "service_history":        history,
    }
    return jsonify(vehicle_out)


# ---------------------------
# Public Purple Report route (VIN-based)
# ---------------------------

@app.route("/vin/<vin>")
def public_report(vin):
    """
    Public VIN-based view:
    https://secure.purpledetailing.com/vin/<VIN>
    """
    vin = normalize_vin(vin)

    # Basic VIN format check (keeps nonsense out)
    if len(vin) != 17:
        return render_template(
            "public_report.html",
            not_found=True,
            vin=vin or "—",
        ), 404

    vehicle = get_vehicle_by_vin(vin)
    if not vehicle:
        return render_template(
            "public_report.html",
            not_found=True,
            vin=vin,
        ), 404

    history = get_service_history_for_vin(vin)
    embed_url = drive_embed_from_folder(vehicle.get("service_history_link"))

    return render_template(
        "public_report.html",
        not_found=False,
        vin=vin,
        vehicle=vehicle,
        service_history=history,
        embed_url=embed_url,
    )


if __name__ == "__main__":
    # Local dev only (Render will use gunicorn)
    app.run(host="0.0.0.0", port=5000, debug=True)
