import sqlite3
import os
import sys

# Attempt to import based on possible locations
try:
    from backend.server.services.detectors import CloseCallDetector
except ImportError:
    try:
        from server.services.detectors import CloseCallDetector
    except ImportError:
        sys.path.append(os.path.join(os.getcwd(), 'backend', 'server', 'services'))
        from detectors import CloseCallDetector

db_path = 'backend/data/projects/gt3_west_fuji_20260423_133015/project.db'

variants = [
    {'avg_lap_time': 90, 'close_call_proximity_seconds': 2.0, 'close_call_max_time_loss': 2.0},
    {'avg_lap_time': 90, 'close_call_proximity_pct': 0.0222222, 'close_call_max_time_loss': 2.0},
    {'avg_lap_time': 900000, 'close_call_proximity_seconds': 2.0, 'close_call_max_time_loss': 2.0}
]

detector = CloseCallDetector()
conn = sqlite3.connect(db_path)
conn.row_factory = sqlite3.Row  # Enable dictionary-like access for rows

for variant in variants:
    events = detector.detect(conn, variant)
    print(f"Variant: {variant} -> Count: {len(events)}")

conn.close()
