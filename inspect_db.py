import sqlite3
import pandas as pd

DB_PATH = 'backend/data/projects/gt3_west_fuji_20260423_133015/project.db'
THRESHOLD = 0.5  # seconds
AVG_LAP_TIME = 90.0  # seconds
MIN_WINDOW_DURATION = 10.0  # seconds

def analyze():
    conn = sqlite3.connect(DB_PATH)
    
    # query to get tick_id, session_time, car_idx, lap, lap_pct
    query = """
    SELECT rt.id as tick_id, rt.session_time, cs.car_idx, cs.lap, cs.lap_pct
    FROM car_states cs
    JOIN race_ticks rt ON cs.tick_id = rt.id
    ORDER BY rt.session_time, cs.car_idx
    """
    df = pd.read_sql_query(query, conn)
    conn.close()

    if df.empty:
        print("No data found.")
        return

    # Calculate global_lap_pct = lap + lap_pct
    df['global_pos'] = df['lap'] + df['lap_pct']
    
    # We want to compare cars at each tick
    ticks = df['tick_id'].unique()
    
    close_pairs_ordered = []
    
    for tick_id, group in df.groupby('tick_id'):
        group = group.sort_values('global_pos', ascending=False)
        session_time = group['session_time'].iloc[0]
        cars = group.to_dict('records')
        
        for i in range(len(cars)):
            for j in range(i + 1, len(cars)):
                car_a = cars[i]
                car_b = cars[j]
                
                # car_a is ahead of car_b (higher global_pos)
                dist_laps = car_a['global_pos'] - car_b['global_pos']
                dist_seconds = dist_laps * AVG_LAP_TIME
                
                if dist_seconds <= THRESHOLD:
                    close_pairs_ordered.append({
                        'tick_id': tick_id,
                        'session_time': session_time,
                        'ahead': car_a['car_idx'],
                        'behind': car_b['car_idx'],
                        'dist_seconds': dist_seconds
                    })

    if not close_pairs_ordered:
        print("No close pairs found.")
        return

    res_df = pd.DataFrame(close_pairs_ordered)
    
    def find_windows(data, pair_key_func):
        data = data.copy()
        data['pair'] = data.apply(pair_key_func, axis=1)
        data = data.sort_values(['pair', 'session_time'])
        
        windows = []
        for pair, group in data.groupby('pair'):
            group = group.sort_values('session_time')
            group['diff'] = group['session_time'].diff()
            
            # Identify groups of continuous points (assuming ticks are frequent enough, 
            # let's say < 2s gap to stay in same window if data is missing, 
            # but usually it's every 0.1s or 1s)
            # Find where gap > 2 * actual tick interval. 
            # For simplicity, if diff > 1.5s, it's a new window (assuming 1Hz or 60Hz data)
            # Let's check typical session time diff first.
            
            group['new_window'] = (group['diff'] > 1.5) | group['diff'].isnull()
            group['window_id'] = group['new_window'].cumsum()
            
            for win_id, win_group in group.groupby('window_id'):
                duration = win_group['session_time'].max() - win_group['session_time'].min()
                if duration >= MIN_WINDOW_DURATION:
                    windows.append({
                        'pair': pair,
                        'start': win_group['session_time'].min(),
                        'end': win_group['session_time'].max(),
                        'duration': duration
                    })
        return windows

    # Ordered (ahead, behind)
    ordered_windows = find_windows(res_df, lambda r: (r['ahead'], r['behind']))
    
    # Unordered {car1, car2}
    unordered_windows = find_windows(res_df, lambda r: tuple(sorted((r['ahead'], r['behind']))))

    print(f"Database used: {DB_PATH}")
    print(f"Number of ordered windows >= 10s: {len(ordered_windows)}")
    print(f"Number of unordered windows >= 10s: {len(unordered_windows)}")
    
    print("\nTop 10 longest ordered windows:")
    top_ordered = sorted(ordered_windows, key=lambda x: x['duration'], reverse=True)[:10]
    for w in top_ordered:
        print(f"Pair {w['pair']}: {w['duration']:.2f}s ({w['start']:.2f} to {w['end']:.2f})")

    print("\nTop 10 longest unordered windows:")
    top_unordered = sorted(unordered_windows, key=lambda x: x['duration'], reverse=True)[:10]
    for w in top_unordered:
        print(f"Pair {w['pair']}: {w['duration']:.2f}s ({w['start']:.2f} to {w['end']:.2f})")

analyze()
