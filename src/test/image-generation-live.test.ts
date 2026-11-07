// @vitest-environment node
// This file is the only image test that reaches the network. It stays skipped in a normal
// `vitest run` and executes only when CALVRAS_LIVE_IMAGE=1 is set, because it spends a real
// generation against whichever provider key is saved on this machine. That is the point: proof
// the tool returns a genuine picture, not a stub.
import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assetNameFrom, generateImage, saveGeneratedImage } from '../lib/runtime/image-generation';
import { providerKeys } from '../lib/runtime/providers';

const live = process.env['CALVRAS_LIVE_IMAGE'] === '1';
const keys = live ? providerKeys() : { gemini: '', openrouter: '' };
const hasKey = Boolean(keys.gemini || keys.openrouter);

describe.skipIf(!live || !hasKey)('live image generation against the saved key', () => {
  it('either writes a real decodable picture or fails honestly — never fabricates a file', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'calvras-image-live-'));
    try {
      let generated;
      try {
        generated = await generateImage({
          prompt: 'A single glossy red apple centred on a plain white background, studio product photograph, soft even lighting',
          aspectRatio: '1:1',
          signal: AbortSignal.timeout(120_000),
        });
      } catch (error) {
        // The honest-failure contract: the tool reached a real provider and reported why it could
        // not draw. A quota/credit/auth rejection is the correct answer when the account cannot pay
        // for images; a grey rectangle written to disk instead is the failure this guards against.
        const message = error instanceof Error ? error.message : String(error);
        expect(message).toMatch(/Image generation failed|No provider key|no image model|outputs images/);
        expect(message).toMatch(/429|402|401|403|quota|credit|no image|refused/);
        const files = await readdir(root).catch(() => []);
        expect(files, "a failed generation must not leave a placeholder asset behind").toEqual([]);
        console.log(JSON.stringify({ live: 'image', outcome: 'honest-failure', message: message.slice(0, 240) }));
        return;
      }
      expect(generated.bytes.length).toBeGreaterThan(2000);
      expect(generated.provider).toMatch(/gemini|openrouter/);
      // PNG magic bytes, or a JPEG header — proof it is a decodable raster and not text.
      const head = generated.bytes.subarray(0, 4);
      const isPng = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
      const isJpeg = head[0] === 0xff && head[1] === 0xd8;
      expect(isPng || isJpeg, `provider returned ${generated.mimeType} with unexpected leading bytes`).toBe(true);

      const saved = await saveGeneratedImage(root, generated, 'assets/hero', assetNameFrom('red apple'));
      const written = await readFile(path.join(root, saved.relativePath));
      expect(written.equals(generated.bytes)).toBe(true);
      expect((await stat(path.join(root, saved.relativePath))).size).toBeGreaterThan(2000);
      console.log(JSON.stringify({ live: 'image', outcome: 'generated', provider: generated.provider, model: generated.model, mime: generated.mimeType, bytes: generated.bytes.length, path: saved.relativePath }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 180_000);
});
