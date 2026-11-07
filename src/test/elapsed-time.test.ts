import { describe, expect, it } from 'vitest';
import { formatElapsed } from '../components/ui/ai-agent-response';

describe('elapsed work time', () => {
  it.each([
    [1, '1s'],
    [7, '7s'],
    [59, '59s'],
    [60, '1m 0s'],
    [90, '1m 30s'],
    [120, '2m 0s'],
    [3725, '1h 2m'],
  ])('%i seconds reads as %s', (seconds, expected) => {
    expect(formatElapsed(seconds)).toBe(expected);
  });
});
