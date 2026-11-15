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

## Practice Bets accounts

Install dependencies with `npm ci`. Set these values on the Sports IQ service before deploying the account feature:

- `DATABASE_URL`: Sports IQ PostgreSQL internal connection string.
- `PUBLIC_ORIGIN`: exact public HTTPS origin, with no trailing slash.
- `RESEND_API_KEY`: sending key for the Sports IQ sign-in emails.
- `PRACTICE_FROM_EMAIL`: sender on a domain verified in Resend.

The service creates its practice tables on first use. Guest browsing works independently of account configuration. Practice sign-in uses a single-use 15-minute email link. Authenticated tickets and results are stored per account, and practice funds are calculated from the server ledger. A one-time browser import displays up to 200 historical tickets separately from server-verified balance and score totals.
