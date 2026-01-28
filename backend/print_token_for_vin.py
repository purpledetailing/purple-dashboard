import sqlite3
import os
import sys

DB_PATH = os.path.join(os.path.dirname(__file__), "Customer_Data.db")

if len(sys.argv) != 2:
    print("Usage: python print_token_for_vin.py <17-char VIN>")
    sys.exit(1)

vin = sys.argv[1].strip().upper()

con = sqlite3.connect(DB_PATH)
cur = con.cursor()

cur.execute("""
    SELECT access_token
    FROM Customer_Data
    WHERE vin_number = ?
""", (vin,))

row = cur.fetchone()
con.close()

if not row or not row[0]:
    print("❌ No token found for that VIN.")
else:
    print("VIN:", vin)
    print("ACCESS TOKEN:", row[0])
