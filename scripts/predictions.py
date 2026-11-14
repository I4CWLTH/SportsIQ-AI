import concurrent.futures
import datetime as dt
import json
import pathlib
import urllib.parse
import urllib.request
from zoneinfo import ZoneInfo

BASE = 'https://sportsiq-ai.onrender.com/api/'
FILE = pathlib.Path('predictions.json')
SPORTS = ('Basketball', 'Football', 'Baseball', 'Soccer', 'Hockey')

def fetch(route, **params):
    with urllib.request.urlopen(BASE + route + '?' + urllib.parse.urlencode(params), timeout=30) as response:
        return json.load(response)

def instant(value):
    return dt.datetime.fromisoformat(value.replace('Z', '+00:00'))

def slate(job):
    sport, level, day = job
    params = dict(sport=sport, level=level, date=day)
    result = []
    for game in fetch('games', **params)['games']:
        pick = game['probability']
        if pick is None and game['status'] == 'Scheduled' and instant(game['date']) > dt.datetime.now(dt.timezone.utc):
            try:
                history = fetch('matchup-history', **params, id=game['id'])
                pick = {'home': 1, 'away': 0}.get(history['pick'])
            except (OSError, ValueError, KeyError):
                pass
        result.append((game, pick))
    return job, result

def main():
    records = json.loads(FILE.read_text()) if FILE.exists() else {}
    today = dt.datetime.now(ZoneInfo('America/Detroit')).date()
    current = {(sport, level, (today + dt.timedelta(days=offset)).isoformat())
               for sport in SPORTS for level in ('pro', 'college') for offset in (0, 1)}
    pending = {tuple(row['slate']) for row in records.values() if row['result'] is None}
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        runs = {pool.submit(slate, job): job for job in sorted(current | pending)}
        for task in concurrent.futures.as_completed(runs):
            try:
                job, games = task.result()
            except (OSError, ValueError, KeyError) as error:
                print(f'{runs[task]}: {error}')
                continue
            for game, pick in games:
                key = '/'.join((*job[:2], str(game['id'])))
                row = records.get(key)
                now = dt.datetime.now(dt.timezone.utc)
                if row is None and pick is not None and game['status'] == 'Scheduled' and now < instant(game['date']):
                    side = 'home' if pick >= .5 else 'away'
                    records[key] = dict(slate=job, side=side, team=game[side]['name'],
                                        recorded=now.isoformat(), result=None)
                elif row is not None and row['result'] is None:
                    status = game['status'].lower()
                    if status.startswith('final') and ' – ' in game['score']:
                        away, home = map(int, game['score'].split(' – '))
                        winner = None if home == away else ('home' if home > away else 'away')
                        row['result'] = 'Draw' if winner is None else ('Yes' if winner == row['side'] else 'No')
                    elif status in ('canceled', 'cancelled'):
                        row['result'] = 'Canceled'
    FILE.write_text(json.dumps(records, indent=2, sort_keys=True) + '\n')

if __name__ == '__main__':
    main()
