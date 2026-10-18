import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { callAI } from '../lib/gemini';
import { LinkifiedText } from '../components/ui/markdown-content';

function stream(events: unknown[]) {
  const encoder = new TextEncoder();
  let index = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (index >= events.length) { controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close(); return; }
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(events[index++])}\n\n`));
    },
  }), { headers: { 'Content-Type': 'text/event-stream' } });
}
const chunk = (text: string) => ({ choices: [{ delta: { content: text }, finish_reason: null }] });
const end = (reason: string) => ({ choices: [{ delta: {}, finish_reason: reason }] });

describe('callAI', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keeps writing past the token cap instead of returning half a document', async () => {
    const responses = [
      stream([chunk('{"message":"Chapter one covers '), end('length')]),
      stream([chunk('the cell, '), end('length')]),
      stream([chunk('then mitosis."}'), end('stop')]),
    ];
    const fetch = vi.fn(async () => responses.shift() ?? new Response('', { status: 500 }));
    vi.stubGlobal('fetch', fetch);

    const text = await callAI('Write a long chapter');
    expect(text).toBe('{"message":"Chapter one covers the cell, then mitosis."}');
    expect(fetch).toHaveBeenCalledTimes(3);
    const continuation = JSON.parse(String((fetch.mock.calls[1] as unknown[])[1] && (fetch.mock.calls[1] as any[])[1].body));
    expect(continuation.messages.map((m: any) => m.role)).toEqual(['system', 'assistant', 'user']);
    expect(continuation.messages[1].content).toBe('{"message":"Chapter one covers ');
  });

  it('stops asking for more once the provider says the reply is finished', async () => {
    const fetch = vi.fn(async () => stream([chunk('{"message":"done"}'), end('stop')]));
    vi.stubGlobal('fetch', fetch);
    expect(await callAI('Short answer please')).toBe('{"message":"done"}');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('link detection', () => {
  it('picks every address out of a plain prompt and styles it as a link', () => {
    render(<LinkifiedText text={'duplicate https://faircare.ie/hospitals and then www.example.org/about, plus http://localhost:3000 later'} />);
    const hrefs = [...document.querySelectorAll('a')].map((anchor) => anchor.getAttribute('href'));
    expect(hrefs).toEqual(['https://faircare.ie/hospitals', 'https://www.example.org/about', 'http://localhost:3000']);
    expect(screen.getByText('www.example.org/about')).toBeInTheDocument();
    expect(screen.getByText(/plus/)).toBeInTheDocument();
  });

  it('leaves a prompt without an address as plain text', () => {
    render(<LinkifiedText text='make the settings page darker' />);
    expect(document.querySelectorAll('a')).toHaveLength(0);
    expect(screen.getByText('make the settings page darker')).toBeInTheDocument();
  });
});
