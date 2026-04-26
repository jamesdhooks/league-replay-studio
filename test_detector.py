import sqlite3
import os
import sys

# Add the project root to sys.path to allow imports from backend
sys.path.append(os.getcwd())

from backend.server.services.detectors import BattleDetector

db_path = 'backend/data/projects/gt3_west_fuji_20260423_133015/project.db'

def run_test(session_info):
    print(f"Running detector with session_info: {session_info}")
    db = sqlite3.connect(db_path)
    # Enable row factory to access columns by name as in the code
    db.row_factory = sqlite3.Row
    detector = BattleDetector()
    battles = detector.detect(db, session_info)
    db.close()
    print(f"Detected {len(battles)} battles")
    return len(battles)

if __name__ == "__main__":
    if not os.path.exists(db_path):
        print(f"Error: Database file not found at {db_path}")
        sys.exit(1)
        
    count1 = run_test({'battle_gap_threshold': 0.5, 'avg_lap_time': 90.0})
    count2 = run_test({'battle_gap_threshold': 0.5, 'avg_lap_time': 900000.0})
    
    print(f"\nResults:")
    print(f"Count 1 (avg_lap_time=90.0): {count1}")
    print(f"Count 2 (avg_lap_time=900000.0): {count2}")
