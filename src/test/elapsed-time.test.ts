import { describe, expect, it } from 'vitest';
import { formatElapsed } from '../components/ui/ai-agent-response';

describe('elapsed work time', () => {
  it.each([
    [1, '1 second'],
    [7, '7 seconds'],
    [59, '59 seconds'],
    [60, '1 minute'],
    [90, '1 min 30s'],
    [120, '2 minutes'],
    [3725, '62 mins 5s'],
  ])('%i seconds reads as %s', (seconds, expected) => {
    expect(formatElapsed(seconds)).toBe(expected);
  });
});
