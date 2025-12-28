import sqlite3

conn = sqlite3.connect("Customer_Data.db")
cursor = conn.cursor()

cursor.execute("SELECT * FROM Customer_Data LIMIT 5")
rows = cursor.fetchall()
for row in rows:
    print(row)

conn.close()
