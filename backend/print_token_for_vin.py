import sqlite3, sys

vin = (sys.argv[1] if len(sys.argv) > 1 else "").strip().upper()
if len(vin) != 17:
    print("Usage: python print_token_for_vin.py <17-char VIN>")
    sys.exit(1)

con = sqlite3.connect("Customer_Data.db")
cur = con.cursor()
cur.execute("""
    SELECT access_token
    FROM Customer_Data
    WHERE vin_number = ?
    LIMIT 1
""", (vin,))
row = cur.fetchone()
con.close()

if not row or not row[0]:
    print("No token found for that VIN.")
else:
    print(row[0])
