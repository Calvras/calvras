import { beforeEach, describe, expect, it } from 'vitest';
import { browserBridge } from '../lib/browser-bridge';

const bridge = browserBridge as unknown as { rememberError(message: string): void };

describe('browser console receipts', () => {
  beforeEach(() => browserBridge.clearConsoleErrors());

  it('reports only the errors seen since the previous action', () => {
    bridge.rememberError('first failure');
    bridge.rememberError('second failure');

    expect(browserBridge.newErrors()).toEqual(['first failure', 'second failure']);
    bridge.rememberError('third failure');
    expect(browserBridge.newErrors()).toEqual(['third failure']);
    expect(browserBridge.newErrors()).toEqual([]);
    expect(browserBridge.getConsoleErrors()).toEqual(['first failure', 'second failure', 'third failure']);
  });

  it('clears both the log and the receipt cursor', () => {
    bridge.rememberError('old failure');
    browserBridge.newErrors();
    browserBridge.clearConsoleErrors();
    bridge.rememberError('fresh failure');
    expect(browserBridge.newErrors()).toEqual(['fresh failure']);
  });
});
