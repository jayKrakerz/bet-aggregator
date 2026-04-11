import { runBacktestSuite } from '../src/api/aviator-tracker.js';

const results = runBacktestSuite();
console.log('strategy                          | trades | WR%   | profit  | EV/bet | breakEvenWR');
console.log('----------------------------------|--------|-------|---------|--------|------------');
for (const r of results) {
  console.log(
    r.strategy.padEnd(33),
    '|', String(r.trades).padStart(6),
    '|', (r.winRate + '%').padStart(5),
    '|', ('$' + r.totalProfit).padStart(7),
    '|', ('$' + r.evPerBet).padStart(6),
    '|', (r.breakEvenWR + '%').padStart(6),
  );
}
