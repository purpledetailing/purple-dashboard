import sqlite3
import csv

CSV_PATH = r'C:\Users\tnqua\Documents\purple-dashboard\backend\db\Customer_Data.csv'
DB_PATH = r'C:\Users\tnqua\Documents\purple-dashboard\backend\db\Customer_Data.db'

# Connect to SQLite (it will create the DB if it doesn't exist)
conn = sqlite3.connect(DB_PATH)
cursor = conn.cursor()

# Drop table if exists
cursor.execute("DROP TABLE IF EXISTS Customer_Data")

# Create table
cursor.execute("""
CREATE TABLE Customer_Data (
    customer_id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_name TEXT,
    status TEXT,
    phone_number TEXT,
    email TEXT,
    address TEXT,
    zip_code TEXT,
    vehicle_nickname TEXT,
    vin_number TEXT,
    make TEXT,
    model TEXT,
    year TEXT,
    license_plate TEXT,
    odometer_at_last_service TEXT,
    lease_or_owned TEXT,
    primary_use TEXT,
    notes TEXT,
    service_history_link TEXT
)
""")

# Read CSV and insert into DB
with open(CSV_PATH, newline='', encoding='utf-8') as csvfile:
    reader = csv.DictReader(csvfile)
    for row in reader:
        cursor.execute("""
        INSERT INTO Customer_Data (
            customer_name, status, phone_number, email, address, zip_code,
            vehicle_nickname, vin_number, make, model, year, license_plate,
            odometer_at_last_service, lease_or_owned, primary_use, notes, service_history_link
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            row['Customer Name'], row['Status'], row['Phone Number'], row['Email'], row['Address'],
            row['Zip Code'], row['Vehicle Nickname'], row['VIN Number'], row['Make'], row['Model'],
            row['Year'], row.get('License Plate (optional)', ''), row['Odometer at Last Service'],
            row['Lease or Owned?'], row['Primary Use'], row['Notes'], row['Service History Link']
        ))

# Commit and close
conn.commit()
conn.close()
print("Database created and CSV imported successfully!")
