import sqlite3
import csv
import os

# Base paths
BASE_DIR = os.path.dirname(__file__)
DB_PATH = os.path.join(BASE_DIR, "Customer_Data.db")
CSV_PATH = os.path.join(BASE_DIR, "db", "Service_History.csv")

print("Using DB:", DB_PATH)
print("Using CSV:", CSV_PATH)

# Connect to the main DB (same one used for Customer_Data)
conn = sqlite3.connect(DB_PATH)
cursor = conn.cursor()

# Create Service_History table
cursor.execute("""
CREATE TABLE IF NOT EXISTS Service_History (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT,
    customer_name TEXT,
    vehicle_vin TEXT,
    service_type TEXT,
    service_notes TEXT,
    next_recommended_service TEXT,
    photos_link TEXT,
    technician TEXT,
    price TEXT,
    customer_feedback TEXT
)
""")

# Clear any old data (optional, but good while you're iterating)
cursor.execute("DELETE FROM Service_History")

# Load CSV
with open(CSV_PATH, newline="", encoding="utf-8") as csvfile:
    reader = csv.DictReader(csvfile)
    rows = list(reader)

    for row in rows:
        cursor.execute("""
            INSERT INTO Service_History (
                date,
                customer_name,
                vehicle_vin,
                service_type,
                service_notes,
                next_recommended_service,
                photos_link,
                technician,
                price,
                customer_feedback
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            (row.get("Date") or "").strip(),
            (row.get("Customer Name") or "").strip(),
            (row.get("Vehicle VIN") or "").strip(),
            (row.get("Service Type") or "").strip(),
            (row.get("Service Notes") or "").strip(),
            (row.get("Next Recommended Service") or "").strip(),
            (row.get("Photos Link") or "").strip(),
            (row.get("Technician") or "").strip(),
            (row.get("Price") or "").strip(),
            (row.get("Customer Feedback") or "").strip(),
        ))

conn.commit()
conn.close()

print("✅ Service_History table created & CSV imported successfully!")
