import { markSprite } from '../../src/dashboard/ui/provider-marks';
import { clientMark } from '../../src/dashboard/ui/views/connections/connections';

describe('the mark of a connected application', () => {
  it('is the vendor whose host publishes the client metadata', () => {
    expect(clientMark('https://claude.ai/oauth/mcp-oauth-client-metadata', null)).toBe('claude');
    expect(clientMark('https://chatgpt.com/connector/metadata.json', 'Connector')).toBe('openai');
    expect(clientMark('https://gemini.google.com/mcp/client.json', null)).toBe('gemini');
    expect(clientMark('https://copilot.microsoft.com/mcp/client.json', null)).toBe('copilot');
    expect(clientMark('https://ai.azure.com/agents/client.json', null)).toBe('azureai');
    expect(clientMark('https://grok.com/mcp/client.json', null)).toBe('grok');
    expect(clientMark('https://www.perplexity.ai/mcp/client.json', null)).toBe('perplexity');
  });

  it('falls back to the name when the document lives elsewhere', () => {
    expect(clientMark('https://tools.example.test/metadata.json', 'Claude Code')).toBe('claude');
    expect(clientMark('https://tools.example.test/metadata.json', 'ChatGPT')).toBe('openai');
    expect(clientMark('not a url', 'Gemini CLI')).toBe('gemini');
    expect(clientMark('https://code.visualstudio.com/oauth', 'GitHub Copilot')).toBe('copilot');
    expect(clientMark('https://tools.example.test/m.json', 'Azure AI Foundry')).toBe('azureai');
    expect(clientMark('https://tools.example.test/m.json', 'Grok')).toBe('grok');
    expect(clientMark('https://tools.example.test/m.json', 'Perplexity')).toBe('perplexity');
  });

  it('is none for an application it does not know, rather than a guess', () => {
    expect(clientMark('https://tools.example.test/metadata.json', 'Test Agent')).toBeNull();
    expect(clientMark('https://claude.ai.example.test/metadata.json', null)).toBeNull();
  });
});

describe('a sprite with a mark that paints in gradients', () => {
  it('keeps the gradients outside the hidden sprite, where browsers draw them', () => {
    const sprite = markSprite(['gemini']);
    const [hidden, visible] = sprite.split('</svg>');

    expect(hidden).toContain('url(#m-gemini-g0)');
    expect(hidden).not.toContain('<linearGradient');
    expect(visible).toContain('id="m-gemini-g0"');
    expect(visible).not.toContain('display="none"');
  });

  it('gives the gradients of every mark ids of their own, so no two marks share one', () => {
    const sprite = markSprite(['gemini', 'copilot', 'azureai']);
    const ids = [...sprite.matchAll(/id="([^"]+)"/g)].map((match) => match[1]);

    expect(new Set(ids).size).toBe(ids.length);
    for (const [, target] of sprite.matchAll(/url\(#([^)]+)\)/g)) expect(ids).toContain(target);
  });

  it('adds nothing for marks that need no gradients', () => {
    expect(markSprite(['claude', 'openai'])).not.toContain('<defs>');
  });
});
