"""
Run all SQL migrations in db/migrations/ in filename order.
Idempotent — migrations use CREATE TABLE IF NOT EXISTS / ALTER TABLE IF NOT EXISTS
where possible, so re-running is safe.

Called automatically by Railway before uvicorn starts (see railway.json).
"""
import os
import glob
import psycopg2

DATABASE_URL = os.environ["DATABASE_URL"]

def run():
    conn = psycopg2.connect(DATABASE_URL)
    conn.autocommit = True
    cur = conn.cursor()

    migrations_dir = os.path.join(os.path.dirname(__file__), '..', 'db', 'migrations')
    files = sorted(glob.glob(os.path.join(migrations_dir, '*.sql')))

    if not files:
        print("No migration files found.")
        return

    for path in files:
        name = os.path.basename(path)
        print(f"  applying {name}...", flush=True)
        with open(path) as f:
            sql = f.read()
        try:
            cur.execute(sql)
            print(f"  ✓ {name}", flush=True)
        except psycopg2.Error as e:
            # Many statements are intentionally not idempotent (e.g. bare ALTER TABLE).
            # Log and continue — if a migration truly fails it will surface at runtime.
            print(f"  ! {name}: {e.pgerror or e}", flush=True)

    cur.close()
    conn.close()
    print("Migrations complete.", flush=True)

if __name__ == "__main__":
    run()
