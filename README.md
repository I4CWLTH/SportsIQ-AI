# SportsIQ AI

Public sports intelligence website. Version 0.1 is a preview; verified schedules and statistical predictions will be integrated later.

## NBA prediction pilot

The prediction workflow also runs `python3 scripts/nba_pilot.py` and saves
`nba-pilot.json`. It captures initial and latest observed pregame snapshots,
including the baseline estimate, season records, recent scoring margins,
reported absences and scoring leaders, venue status, rest, and timestamped
moneylines when available. The latest snapshot is the last successful capture
before tipoff and may precede late lineup news.

The pilot compares regularized logistic regression with and without the
market against the current rule and the no-vig moneyline on matching games.
Each walk-forward run requires 100 earlier graded games and reports accuracy
and Brier score over up to 45 recent evaluation dates. Missing features remain
null in snapshots. The models use zero as the neutral value during fitting.
The availability feature measures reported absent scoring leaders. Replacement
quality, opponent-adjusted efficiency, matchup style, travel, and rotation
continuity require additional data. Pilot estimates do not select site picks.
