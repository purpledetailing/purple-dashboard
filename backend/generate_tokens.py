import sqlite3
import os
import secrets

DB_PATH = os.path.join(os.path.dirname(__file__), "Customer_Data.db")

def column_exists(cur, table, column):
    cur.execute(f"PRAGMA table_info({table})")
    return any(row[1] == column for row in cur.fetchall())

def main():
    con = sqlite3.connect(DB_PATH)
    cur = con.cursor()

    # Ensure access_token column exists
    if not column_exists(cur, "Customer_Data", "access_token"):
        print("➕ Adding access_token column...")
        cur.execute("""
            ALTER TABLE Customer_Data
            ADD COLUMN access_token TEXT
        """)
        con.commit()

    # Generate tokens for rows missing them
    cur.execute("""
        SELECT customer_id
        FROM Customer_Data
        WHERE access_token IS NULL OR access_token = ''
    """)
    rows = cur.fetchall()

    if not rows:
        print("✅ All vehicles already have access tokens.")
        con.close()
        return

    print(f"🔑 Generating tokens for {len(rows)} vehicle(s)...")

    for (customer_id,) in rows:
        token = secrets.token_urlsafe(16)
        cur.execute("""
            UPDATE Customer_Data
            SET access_token = ?
            WHERE customer_id = ?
        """, (token, customer_id))

    con.commit()
    con.close()
    print("✅ Tokens generated successfully.")

if __name__ == "__main__":
    main()
