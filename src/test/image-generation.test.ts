// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { assetNameFrom, geminiImageModels, openRouterImageModels, saveGeneratedImage } from '../lib/runtime/image-generation';
import { validateToolAction } from '../lib/tool-catalog';

const pngBase64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAABJRU5ErkJggg==';
const pngBytes = Buffer.from(pngBase64, 'base64');

describe('image generation routing', () => {
  it('advertises generate_image as a project-writing tool that needs a prompt', () => {
    expect(validateToolAction({ type: 'generate_image', prompt: 'a red fox on a hill' }).type).toBe('generate_image');
    expect(() => validateToolAction({ type: 'generate_image' })).toThrow(/prompt/);
    expect(() => validateToolAction({ type: 'generate_image', prompt: '   ' })).toThrow(/prompt/);
  });

  it('reads the image-capable models off each provider list rather than guessing names', () => {
    expect(
      geminiImageModels({
        models: [
          { name: 'models/gemini-2.0-flash', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-2.0-flash-preview-image-generation', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
        ],
      }),
    ).toEqual(['gemini-2.0-flash-preview-image-generation']);
    expect(
      openRouterImageModels({
        data: [
          { id: 'openai/gpt-4o', architecture: { output_modalities: ['text'] } },
          { id: 'google/gemini-2.5-flash-image', architecture: { output_modalities: ['text', 'image'] } },
        ],
      }),
    ).toEqual(['google/gemini-2.5-flash-image']);
  });

  it('writes the returned picture into the project and reports the path to import', async () => {
    const { mkdtemp, readFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const root = await mkdtemp(path.join(tmpdir(), 'calvras-image-test-'));
    try {
      const saved = await saveGeneratedImage(root, { bytes: pngBytes, mimeType: 'image/png', model: 'm', provider: 'gemini' }, 'assets/hero', assetNameFrom('a red fox on a hill'));
      expect(saved.relativePath).toBe('assets/hero.png');
      const written = await readFile(path.join(root, 'assets/hero.png'));
      expect(written.equals(pngBytes)).toBe(true);

      const byPrompt = await saveGeneratedImage(root, { bytes: pngBytes, mimeType: 'image/png', model: 'm', provider: 'gemini' }, '', assetNameFrom('a red fox on a hill'));
      expect(byPrompt.relativePath).toBe('assets/generated/a-red-fox-on-a.png');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses to write outside the project rather than escaping the workspace', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const root = await mkdtemp(path.join(tmpdir(), 'calvras-image-test-'));
    try {
      const image = { bytes: pngBytes, mimeType: 'image/png', model: 'm', provider: 'gemini' };
      await expect(saveGeneratedImage(root, image, '../outside.png', 'x')).rejects.toThrow(/inside the project/);
      await expect(saveGeneratedImage(root, image, 'C:/Windows/evil.png', 'x')).rejects.toThrow(/inside the project/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
