import crypto from 'node:crypto';
import { Card } from './types.js';

export interface EvaluatedHand {
  rank: number;
  name: string;
  value: number;
  description: string;
}

const RANK_VALUES: Record<string, number> = {
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
  '10': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14
};

const ALL_SUITS = [
  { symbol: '♠', name: 'spades', color: 'text-zinc-100', isRed: false },
  { symbol: '♥', name: 'hearts', color: 'text-rose-500', isRed: true },
  { symbol: '♦', name: 'diamonds', color: 'text-[#E2B755]', isRed: true },
  { symbol: '♣', name: 'clubs', color: 'text-emerald-400', isRed: false },
];

const ALL_RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

export function createDeck(): Card[] {
  const deck: Card[] = [];
  let id = 1;
  for (const suit of ALL_SUITS) {
    for (const rank of ALL_RANKS) {
      deck.push({
        id: `card-${id++}`,
        rank,
        suit: suit.symbol,
        color: suit.color,
        isRed: suit.isRed,
        suitName: suit.name
      });
    }
  }
  return shuffleDeck(deck);
}

export function shuffleDeck(deck: Card[]): Card[] {
  const array = [...deck];
  for (let i = array.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

export function evaluate7CardHand(cards: Card[]): EvaluatedHand {
  if (!cards || cards.length < 5) {
    return { rank: 0, name: 'High Card', value: 0, description: 'High Card' };
  }

  const combinations = getCombinations(cards, 5);
  let bestScore = -1;
  let bestEval: EvaluatedHand = { rank: 1, name: 'High Card', value: 0, description: 'High Card' };

  for (const combo of combinations) {
    const ev = evaluate5CardHand(combo);
    if (ev.value > bestScore) {
      bestScore = ev.value;
      bestEval = ev;
    }
  }

  return bestEval;
}

function getCombinations<T>(arr: T[], k: number): T[][] {
  if (k === 0) return [[]];
  if (arr.length === 0) return [];
  const [head, ...tail] = arr;
  const withHead = getCombinations(tail, k - 1).map(c => [head, ...c]);
  const withoutHead = getCombinations(tail, k);
  return [...withHead, ...withoutHead];
}

function evaluate5CardHand(cards: Card[]): EvaluatedHand {
  const sorted = [...cards].sort((a, b) => RANK_VALUES[b.rank] - RANK_VALUES[a.rank]);
  const ranks = sorted.map(c => RANK_VALUES[c.rank]);
  const suits = sorted.map(c => c.suit);

  const isFlush = suits.every(s => s === suits[0]);

  let isStraight = false;
  let straightHigh = 0;

  if (
    ranks[0] - ranks[1] === 1 &&
    ranks[1] - ranks[2] === 1 &&
    ranks[2] - ranks[3] === 1 &&
    ranks[3] - ranks[4] === 1
  ) {
    isStraight = true;
    straightHigh = ranks[0];
  } else if (
    ranks[0] === 14 && ranks[1] === 5 && ranks[2] === 4 && ranks[3] === 3 && ranks[4] === 2
  ) {
    isStraight = true;
    straightHigh = 5;
  }

  const counts: Record<number, number> = {};
  ranks.forEach(r => { counts[r] = (counts[r] || 0) + 1; });

  const countValues = Object.values(counts).sort((a, b) => b - a);

  if (isFlush && isStraight) {
    if (straightHigh === 14) {
      return { rank: 10, name: 'Royal Flush', value: 10000000 + straightHigh, description: 'Royal Flush' };
    }
    return { rank: 9, name: 'Straight Flush', value: 9000000 + straightHigh, description: `Straight Flush, ${getRankName(straightHigh)} High` };
  }

  if (countValues[0] === 4) {
    const quadRank = Number(Object.keys(counts).find(k => counts[Number(k)] === 4));
    const kicker = Number(Object.keys(counts).find(k => counts[Number(k)] === 1));
    return { rank: 8, name: 'Four of a Kind', value: 8000000 + quadRank * 100 + kicker, description: `Four of a Kind, ${getRankName(quadRank)}s` };
  }

  if (countValues[0] === 3 && countValues[1] === 2) {
    const tripRank = Number(Object.keys(counts).find(k => counts[Number(k)] === 3));
    const pairRank = Number(Object.keys(counts).find(k => counts[Number(k)] === 2));
    return { rank: 7, name: 'Full House', value: 7000000 + tripRank * 100 + pairRank, description: `Full House, ${getRankName(tripRank)}s full of ${getRankName(pairRank)}s` };
  }

  if (isFlush) {
    const val = 6000000 + ranks[0] * 10000 + ranks[1] * 1000 + ranks[2] * 100 + ranks[3] * 10 + ranks[4];
    return { rank: 6, name: 'Flush', value: val, description: `Flush, ${getRankName(ranks[0])} High` };
  }

  if (isStraight) {
    return { rank: 5, name: 'Straight', value: 5000000 + straightHigh, description: `Straight, ${getRankName(straightHigh)} High` };
  }

  if (countValues[0] === 3) {
    const tripRank = Number(Object.keys(counts).find(k => counts[Number(k)] === 3));
    const kickers = ranks.filter(r => r !== tripRank);
    return { rank: 4, name: 'Three of a Kind', value: 4000000 + tripRank * 1000 + kickers[0] * 10 + kickers[1], description: `Three of a Kind, ${getRankName(tripRank)}s` };
  }

  if (countValues[0] === 2 && countValues[1] === 2) {
    const pairs = Object.keys(counts).filter(k => counts[Number(k)] === 2).map(Number).sort((a, b) => b - a);
    const kicker = Number(Object.keys(counts).find(k => counts[Number(k)] === 1));
    return { rank: 3, name: 'Two Pair', value: 3000000 + pairs[0] * 10000 + pairs[1] * 100 + kicker, description: `Two Pair, ${getRankName(pairs[0])}s and ${getRankName(pairs[1])}s` };
  }

  if (countValues[0] === 2) {
    const pairRank = Number(Object.keys(counts).find(k => counts[Number(k)] === 2));
    const kickers = ranks.filter(r => r !== pairRank);
    return { rank: 2, name: 'One Pair', value: 2000000 + pairRank * 10000 + kickers[0] * 100 + kickers[1] * 10 + kickers[2], description: `Pair of ${getRankName(pairRank)}s` };
  }

  const highVal = 1000000 + ranks[0] * 10000 + ranks[1] * 1000 + ranks[2] * 100 + ranks[3] * 10 + ranks[4];
  return { rank: 1, name: 'High Card', value: highVal, description: `High Card, ${getRankName(ranks[0])}` };
}

function getRankName(r: number): string {
  switch (r) {
    case 14: return 'Ace';
    case 13: return 'King';
    case 12: return 'Queen';
    case 11: return 'Jack';
    case 10: return 'Ten';
    default: return String(r);
  }
}
