import sqlite3, sys, pathlib

DB_PATH = pathlib.Path("Customer_Data.db")
SQL_PATH = pathlib.Path("migrate_tokens.sql")

if not DB_PATH.exists():
    print(f"ERROR: {DB_PATH} not found in {DB_PATH.resolve().parent}")
    sys.exit(1)

sql = SQL_PATH.read_text(encoding="utf-8")

con = sqlite3.connect(str(DB_PATH))
cur = con.cursor()

for stmt in [s.strip() for s in sql.split(";") if s.strip()]:
    try:
        cur.execute(stmt)
    except sqlite3.OperationalError as e:
        # Allow "duplicate column name" if you've already run once.
        msg = str(e).lower()
        if "duplicate column name" in msg:
            print("Skip: column already exists.")
            continue
        if "already exists" in msg:
            print("Skip: index already exists.")
            continue
        raise

con.commit()
con.close()
print("Migration applied (or already up-to-date).")
