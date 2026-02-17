import type { Grade } from '../types/result.js';

interface PredictionToGrade {
  pick_type: string;
  side: string;
  value: number | null;
}

interface GameScore {
  homeScore: number;
  awayScore: number;
}

/**
 * Pure grading functions — no side effects, no DB.
 */

export function gradeMoneyline(pred: PredictionToGrade, score: GameScore): Grade {
  const { homeScore, awayScore } = score;
  if (homeScore === awayScore) return 'push';
  const homeWon = homeScore > awayScore;
  if (pred.side === 'home') return homeWon ? 'win' : 'loss';
  if (pred.side === 'away') return homeWon ? 'loss' : 'win';
  if (pred.side === 'draw') return 'loss'; // draw picked but game not drawn
  return 'void';
}

export function gradeSpread(pred: PredictionToGrade, score: GameScore): Grade {
  if (pred.value == null) return 'void';
  const { homeScore, awayScore } = score;
  // Spread is from the perspective of the chosen side
  // e.g. home -3.5 means home needs to win by more than 3.5
  const actualMargin = homeScore - awayScore;
  const adjustedMargin = pred.side === 'home'
    ? actualMargin + pred.value
    : -actualMargin + pred.value;

  if (adjustedMargin > 0) return 'win';
  if (adjustedMargin < 0) return 'loss';
  return 'push';
}

export function gradeOverUnder(pred: PredictionToGrade, score: GameScore): Grade {
  if (pred.value == null) return 'void';
  const total = score.homeScore + score.awayScore;
  if (pred.side === 'over') {
    if (total > pred.value) return 'win';
    if (total < pred.value) return 'loss';
    return 'push';
  }
  if (pred.side === 'under') {
    if (total < pred.value) return 'win';
    if (total > pred.value) return 'loss';
    return 'push';
  }
  return 'void';
}

export function gradeBtts(pred: PredictionToGrade, score: GameScore): Grade {
  const bothScored = score.homeScore > 0 && score.awayScore > 0;
  if (pred.side === 'yes') return bothScored ? 'win' : 'loss';
  if (pred.side === 'no') return bothScored ? 'loss' : 'win';
  return 'void';
}

/**
 * Grade a single prediction given game scores.
 */
export function gradePrediction(pred: PredictionToGrade, score: GameScore): Grade {
  switch (pred.pick_type) {
    case 'moneyline': return gradeMoneyline(pred, score);
    case 'spread': return gradeSpread(pred, score);
    case 'over_under': return gradeOverUnder(pred, score);
    case 'prop': return gradeBtts(pred, score);
    case 'parlay': return 'void';
    default: return 'void';
  }
}
