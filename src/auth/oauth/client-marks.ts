/**
 * Which vendor's mark a connected application gets, on the consent page and in
 * the list of connections
 *
 * The client id is the URL of the application's metadata document, so its host
 * is the vendor's own; the name is the fallback for a client whose document
 * lives elsewhere. The marks themselves are in `dashboard/ui/marks/`
 */

const CLIENT_MARKS: { mark: string; hosts: string[]; name: RegExp }[] = [
  { mark: 'claude', hosts: ['claude.ai', 'anthropic.com'], name: /\bclaude\b/i },
  { mark: 'openai', hosts: ['openai.com', 'chatgpt.com'], name: /\b(chatgpt|openai|codex)\b/i },
  { mark: 'gemini', hosts: ['gemini.google.com'], name: /\bgemini\b/i },
  { mark: 'copilot', hosts: ['copilot.microsoft.com', 'githubcopilot.com'], name: /\bcopilot\b/i },
  { mark: 'azureai', hosts: ['ai.azure.com'], name: /\b(azure ai|ai foundry|azure foundry)\b/i },
  { mark: 'grok', hosts: ['x.ai', 'grok.com'], name: /\b(grok|xai)\b/i },
  { mark: 'perplexity', hosts: ['perplexity.ai'], name: /\bperplexity\b/i },
];

/** The mark for a connected application, or null when it is none we know */
export function clientMark(clientId: string, clientName: string | null): string | null {
  let host = '';
  try {
    host = new URL(clientId).hostname.toLowerCase();
  } catch {
    // Not a URL
  }
  const byHost = CLIENT_MARKS.find(({ hosts }) =>
    hosts.some((known) => host === known || host.endsWith(`.${known}`)),
  );
  if (byHost) return byHost.mark;
  return CLIENT_MARKS.find(({ name }) => name.test(clientName ?? ''))?.mark ?? null;
}
