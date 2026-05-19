import { calculateSimilarity, findFuzzyMatches } from '../src/utils/fuzzy-match';

// Guards the two-row Levenshtein rewrite (#126 / ADR-104). The optimization
// must not change matching *outcomes* — only memory/CPU. These pin known
// Levenshtein distances so a regression in the row-swap logic is caught.
describe('calculateSimilarity (two-row Levenshtein)', () => {
  test('identical strings score 1', () => {
    expect(calculateSimilarity('hello world', 'hello world')).toBe(1);
  });

  test('both empty score 1', () => {
    expect(calculateSimilarity('', '')).toBe(1);
  });

  test('one empty scores 0', () => {
    expect(calculateSimilarity('', 'abc')).toBe(0);
    expect(calculateSimilarity('abc', '')).toBe(0);
  });

  test('kitten/sitting → distance 3 of max-len 7', () => {
    // classic Levenshtein example: distance 3
    expect(calculateSimilarity('kitten', 'sitting')).toBeCloseTo(1 - 3 / 7, 6);
  });

  test('flaw/lawn → distance 2 of max-len 4', () => {
    expect(calculateSimilarity('flaw', 'lawn')).toBeCloseTo(1 - 2 / 4, 6);
  });

  test('is case-insensitive', () => {
    expect(calculateSimilarity('Hello', 'hello')).toBe(1);
  });

  test('is symmetric (row order must not matter after the rewrite)', () => {
    const a = 'the quick brown fox';
    const b = 'the quikc brwn fx';
    expect(calculateSimilarity(a, b)).toBeCloseTo(calculateSimilarity(b, a), 9);
  });
});

describe('findFuzzyMatches', () => {
  const content = [
    'The quick brown fox jumps',
    'over the lazy dog',
    'completely unrelated text here',
  ].join('\n');

  test('exact substring is a similarity-1 match with correct line number', () => {
    const m = findFuzzyMatches(content, 'lazy dog', 0.7);
    expect(m.length).toBeGreaterThan(0);
    expect(m[0].similarity).toBe(1.0);
    expect(m[0].lineNumber).toBe(2);
  });

  test('near match above threshold is found despite the heuristic skips', () => {
    const m = findFuzzyMatches(content, 'quick brown fox', 0.6);
    expect(m.some(x => x.lineNumber === 1)).toBe(true);
  });

  test('unrelated query below threshold yields nothing', () => {
    expect(findFuzzyMatches(content, 'xylophone zeppelin quasar', 0.7)).toEqual([]);
  });

  test('empty / whitespace search returns no matches', () => {
    expect(findFuzzyMatches(content, '', 0.7)).toEqual([]);
    expect(findFuzzyMatches(content, '   ', 0.7)).toEqual([]);
  });
});
