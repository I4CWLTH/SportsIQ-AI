"""Capture pregame NBA features and score a shadow model in chronological order."""
import datetime as dt
import json
import math
from pathlib import Path
from zoneinfo import ZoneInfo

from predictions import fetch, instant

ARCHIVE = Path('nba-pilot.json')
FEATURES = ('strength', 'form', 'availability', 'home_court', 'rest')
MIN_TRAIN = 100


def estimate(weights, features):
    score = sum(weight * value for weight, value in zip(weights, features))
    return 1 / (1 + math.exp(-max(-35, min(35, score))))


def fit(rows, fields):
    weights = [0.] * (len(fields) + 1)
    inputs = [(vector(row, fields), target) for row, target in rows]
    for _ in range(160):
        gradient = [0.] * len(weights)
        for values, target in inputs:
            error = estimate(weights, values) - target
            for i, value in enumerate(values):
                gradient[i] += error * value
        for i in range(len(weights)):
            weights[i] -= .6 * (gradient[i] / len(inputs) + (.025 * weights[i] if i else 0))
    return weights


def vector(row, fields):
    return [1.] + [row['features'].get(key) or 0. for key in fields]


def moneyline(value):
    try:
        number = int(str(value).replace('−', '-'))
    except (ValueError, TypeError):
        return None
    if abs(number) < 100:
        return None
    return 100 / (number + 100) if number > 0 else -number / (100 - number)


def report(games, phase):
    samples = sorted(
        ((game, game[phase]) for game in games.values()
         if game.get('result') is not None and phase in game and game[phase].get('baseline') is not None),
        key=lambda pair: pair[1]['at'],
    )
    scores = {}
    for day in sorted({row['at'][:10] for _, row in samples})[-45:]:
        training = [(row, game['result']) for game, row in samples
                    if game['result_at'][:10] < day][-600:]
        if len(training) < MIN_TRAIN:
            continue
        model = fit(training, FEATURES)
        market_training = [(row, target) for row, target in training if row['features'].get('market') is not None]
        market_model = fit(market_training, (*FEATURES, 'market')) if len(market_training) >= MIN_TRAIN else None
        for game, row in samples:
            if row['at'][:10] != day:
                continue
            target = game['result']
            base = row['baseline']
            pilot = estimate(model, vector(row, FEATURES))
            predictions = {'baseline': base, 'pilot': pilot}
            market = row['features'].get('market')
            if market_model and market is not None:
                predictions.update(market_matched_baseline=base, market_matched_pilot=pilot,
                                   market_only=.5 + market,
                                   pilot_with_market=estimate(market_model, vector(row, (*FEATURES, 'market'))))
            for name, probability in predictions.items():
                count, correct, error = scores.get(name, (0, 0, 0.))
                scores[name] = (count + 1, correct + int((probability >= .5) == target),
                                error + (probability - target) ** 2)
    return {name: dict(games=count, accuracy=round(correct/count, 4), brier=round(error/count, 4))
            for name, (count, correct, error) in scores.items()}


def record_rate(text):
    try:
        wins, losses = map(int, text.split('-')[:2])
        return (wins + 2) / (wins + losses + 4)
    except (AttributeError, ValueError):
        return None


def difference(home, away):
    return home - away if home is not None and away is not None else None


def team_history(team_id, completed, now):
    prior = sorted((g for g in completed.values() if instant(g['result_at']) < now and team_id in g['teams']),
                   key=lambda g: g['tip'], reverse=True)[:10]
    if not prior:
        return None, None
    points = [(g['scores'][g['teams'].index(team_id)], g['scores'][1-g['teams'].index(team_id)]) for g in prior]
    weights = [0.84 ** i for i in range(len(points))]
    margin = sum(w*(scored-allowed) for w, (scored, allowed) in zip(weights, points))/sum(weights)
    elapsed = (now-instant(prior[0]['tip'])).total_seconds()/86400
    return margin/20, min(elapsed, 5)/5


def unavailable_output(team, report):
    if not report or not report.get('available'):
        return None
    out = [player for player in report.get('players', []) if player.get('out')]
    return sum(float(leader['value']) for leader in team.get('leaders', [])
               if leader['category'].lower() == 'points per game'
               and any(leader['name'].casefold() == player['name'].casefold() for player in out))/30


def snapshot(game, reports, completed, odds, now):
    away, home = game['away'], game['home']
    away_form, away_rest = team_history(str(away['id']), completed, now)
    home_form, home_rest = team_history(str(home['id']), completed, now)
    away_line, home_line = moneyline(odds.get('away')), moneyline(odds.get('home'))
    market = home_line/(home_line + away_line)-.5 if away_line and home_line else None
    features = dict(
        strength=difference(record_rate(home['record']), record_rate(away['record'])),
        form=difference(home_form, away_form),
        availability=difference(unavailable_output(away, reports.get(str(away['id']))),
                                unavailable_output(home, reports.get(str(home['id'])))),
        home_court=None if game.get('neutralSite') is None else float(not game['neutralSite']),
        rest=difference(home_rest, away_rest), market=market,
    )
    return dict(at=now.isoformat(), baseline=game['probability'], features=features,
                odds=odds, teams=[away,home],
                injury_reports=[reports.get(str(team['id'])) for team in (away,home)])


def main():
    data = json.loads(ARCHIVE.read_text()) if ARCHIVE.exists() else {'version': 1, 'games': {}, 'completed': {}}
    games, completed = data['games'], data['completed']
    quotes = json.loads(Path('lines.json').read_text()) if Path('lines.json').exists() else {}
    now = dt.datetime.now(dt.timezone.utc)
    today = now.astimezone(ZoneInfo('America/Detroit')).date()
    pending = {dt.date.fromisoformat(g['slate']) for g in games.values() if g.get('result') is None and not g.get('closed')}
    dates = pending | {today + dt.timedelta(days=n) for n in (-1, 0, 1)}
    for day in sorted(dates):
        try:
            rows = fetch('games', sport='Basketball', level='pro', date=day.isoformat())['games']
        except (OSError, ValueError, KeyError) as error:
            print(f'NBA scoreboard {day}: {error}')
            continue
        for game in rows:
            observed = dt.datetime.now(dt.timezone.utc)
            key = str(game['id'])
            away, home = str(game['away']['id']), str(game['home']['id'])
            tip = instant(game['date'])
            if game['status'].lower().startswith('final'):
                try:
                    a, h = map(int, game['score'].split(' – '))
                except ValueError:
                    continue
                if a == h:
                    continue
                finished = completed.setdefault(key, dict(tip=game['date'], result_at=observed.isoformat(),
                                                          teams=[away, home], scores=[a, h]))
                if key in games:
                    games[key].update(result=int(h > a), result_at=finished['result_at'])
            elif game['status'].lower() in ('canceled', 'cancelled', 'postponed'):
                if key in games:
                    games[key]['closed'] = game['status']
            elif game.get('state') == 'pre' and observed < tip:
                try:
                    report_rows = fetch('nba/injuries', away=away, home=home).get('teams', [])
                except (OSError, ValueError):
                    report_rows = []
                observed = dt.datetime.now(dt.timezone.utc)
                if observed >= tip:
                    continue
                injuries = {str(row['id']): row for row in report_rows}
                valid = [q for q in quotes.get('basketball/nba/'+key, [])
                         if instant(q['at']) <= observed and moneyline(q.get('away')) and moneyline(q.get('home'))]
                odds = max(valid, key=lambda q: q['at'], default={})
                row = snapshot(game, injuries, completed, odds, observed)
                entry = games.setdefault(key, {'slate': day.isoformat(), 'tip': game['date']})
                entry.pop('closed', None)
                entry['tip'] = game['date']
                training = sorted(
                    ((prior['latest'], prior['result']) for prior in games.values()
                     if prior.get('result') is not None and 'latest' in prior
                     and instant(prior['result_at']) < observed),
                    key=lambda sample: sample[0]['at'])[-600:]
                if len(training) >= MIN_TRAIN:
                    row['shadow_probability'] = estimate(fit(training, FEATURES), vector(row, FEATURES))
                    rows_with_odds = [(sample, result) for sample, result in training
                                      if sample['features'].get('market') is not None]
                    if row['features'].get('market') is not None and len(rows_with_odds) >= MIN_TRAIN:
                        fields = (*FEATURES, 'market')
                        row['shadow_with_market'] = estimate(fit(rows_with_odds, fields), vector(row, fields))
                entry.setdefault('initial', row)
                entry['latest'] = row
    data['evaluation'] = {phase: report(games, phase) for phase in ('initial', 'latest')}
    data['min_training_games'] = MIN_TRAIN
    ARCHIVE.write_text(json.dumps(data, sort_keys=True, separators=(',', ':'))+'\n')
    print('NBA pilot:', len(games), 'captured games;', data['evaluation'])


if __name__ == '__main__':
    main()
