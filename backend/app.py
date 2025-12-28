from flask import Flask, render_template, request, jsonify
import sqlite3
import re

app = Flask(__name__)

DB_PATH = "Customer_Data.db"


def get_db_connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


@app.route("/")
def index():
    # Internal dashboard (the VIN search you already have)
    return render_template("index.html")


@app.route("/search")
def search():
    """
    Internal JSON API used by your internal Purple Dashboard screen.
    Returns full customer info + service history for a VIN.
    """
    vin = request.args.get("vin", "").strip()

    if not vin or len(vin) != 17:
        return jsonify({"error": "Please provide a full 17-character VIN."}), 400

    conn = get_db_connection()
    cur = conn.cursor()

    # Main customer/vehicle record
    cur.execute(
        """
        SELECT
            customer_id,
            customer_name,
            status,
            phone_number,
            email,
            address,
            zip_code,
            vehicle_nickname,
            vin_number,
            make,
            model,
            year,
            license_plate,
            odometer_at_last_service,
            lease_or_owned,
            primary_use,
            notes,
            service_history_link
        FROM Customer_Data
        WHERE vin_number = ?
        """,
        (vin,),
    )
    row = cur.fetchone()

    if not row:
        conn.close()
        return jsonify({"error": "VIN not found in Customer_Data."}), 404

    # Service history (if table exists)
    try:
        cur.execute(
            """
            SELECT
                date,
                service_type,
                service_notes,
                next_recommended_service,
                photos_link
            FROM Service_History
            WHERE vehicle_vin = ?
            ORDER BY date DESC
            """,
            (vin,),
        )
        history_rows = cur.fetchall()
        service_history = [
            {
                "date": hr["date"],
                "service_type": hr["service_type"],
                "service_notes": hr["service_notes"],
                "next_recommended_service": hr["next_recommended_service"],
                "photos_link": hr["photos_link"],
            }
            for hr in history_rows
        ]
    except sqlite3.OperationalError:
        # If Service_History table doesn’t exist yet
        service_history = []

    conn.close()

    data = dict(row)
    data["service_history"] = service_history

    return jsonify(data)


@app.route("/public/<vin>")
def public_vehicle(vin):
    """
    Public, customer-facing page.
    Shows ONLY vehicle + service info (no name/address/phone).
    URL example: /public/4JGFB4FB9RB121790
    """
    vin = vin.strip()

    conn = get_db_connection()
    cur = conn.cursor()

    # Pull the core vehicle info
    cur.execute(
        """
        SELECT
            vin_number,
            make,
            model,
            year,
            vehicle_nickname,
            service_history_link
        FROM Customer_Data
        WHERE vin_number = ?
        """,
        (vin,),
    )
    row = cur.fetchone()

    if not row:
        conn.close()
        # Simple “not found” page
        return render_template(
            "public_vehicle.html",
            not_found=True,
            vin=vin,
            vehicle=None,
            service_history=[],
            embed_url=None,
        )

    # Service history for that VIN
    try:
        cur.execute(
            """
            SELECT
                date,
                service_type,
                service_notes,
                next_recommended_service,
                photos_link
            FROM Service_History
            WHERE vehicle_vin = ?
            ORDER BY date DESC
            """,
            (vin,),
        )
        history_rows = cur.fetchall()
        service_history = [
            {
                "date": hr["date"],
                "service_type": hr["service_type"],
                "service_notes": hr["service_notes"],
                "next_recommended_service": hr["next_recommended_service"],
                "photos_link": hr["photos_link"],
            }
            for hr in history_rows
        ]
    except sqlite3.OperationalError:
        service_history = []

    conn.close()

    vehicle = {
        "vin_number": row["vin_number"],
        "make": row["make"],
        "model": row["model"],
        "year": row["year"],
        "vehicle_nickname": row["vehicle_nickname"],
        "service_history_link": row["service_history_link"],
    }

    # Build Google Drive embed URL if folder link exists
    embed_url = None
    folder_url = (row["service_history_link"] or "").strip()
    if folder_url:
        m = re.search(r"/folders/([^/?]+)", folder_url)
        if m:
            folder_id = m.group(1)
            embed_url = f"https://drive.google.com/embeddedfolderview?id={folder_id}#grid"

    return render_template(
        "public_vehicle.html",
        not_found=False,
        vin=vin,
        vehicle=vehicle,
        service_history=service_history,
        embed_url=embed_url,
    )


if __name__ == "__main__":
    # Run in debug for local development
    app.run(debug=True)
