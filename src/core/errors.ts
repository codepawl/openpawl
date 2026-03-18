import pc from 'picocolors';

export const PROVIDER_URLS: Record<string, { keyUrl: string | null; statusUrl: string }> = {
  anthropic:  { keyUrl: 'https://console.anthropic.com/settings/keys', statusUrl: 'https://status.anthropic.com' },
  openai:     { keyUrl: 'https://platform.openai.com/api-keys', statusUrl: 'https://status.openai.com' },
  openrouter: { keyUrl: 'https://openrouter.ai/settings/keys', statusUrl: 'https://openrouter.ai' },
  deepseek:   { keyUrl: 'https://platform.deepseek.com/api_keys', statusUrl: 'https://platform.deepseek.com' },
  groq:       { keyUrl: 'https://console.groq.com/keys', statusUrl: 'https://console.groq.com' },
  ollama:     { keyUrl: null, statusUrl: 'http://localhost:11434' },
  custom:     { keyUrl: null, statusUrl: '' },
};

export const API_KEY_PREFIXES: Record<string, string | null> = {
  anthropic: 'sk-ant-',
  openai: 'sk-',
  openrouter: 'sk-or-',
  deepseek: 'sk-',
  groq: 'gsk_',
  ollama: null,
  custom: null,
};

export function validateApiKeyFormat(
  provider: string,
  key: string,
): { valid: boolean; hint: string } {
  const prefix = API_KEY_PREFIXES[provider] ?? null;

  if (prefix === null) {
    return { valid: true, hint: '' };
  }

  if (key.startsWith(prefix)) {
    return { valid: true, hint: '' };
  }

  return {
    valid: false,
    hint: `Expected key to start with "${prefix}" for ${provider}`,
  };
}

export function maskApiKey(key: string): string {
  if (key.length <= 8) {
    return `${key}...****`;
  }
  return `${key.slice(0, 8)}...****`;
}

export const ERROR_MESSAGES: Record<string, { title: string; body: string; fix: string[] }> = {
  CONNECTION_FAILED: {
    title: 'Could not connect to {provider}',
    body: 'The {provider} service may be down or your internet connection may have an issue.',
    fix: [
      'Check your internet connection',
      'Check {provider} status at {statusUrl}',
      'Try again in a few minutes',
    ],
  },
  AUTHENTICATION_FAILED: {
    title: 'Invalid API key for {provider}',
    body: 'Your API key was rejected. It may be expired or incorrect.',
    fix: [
      'Get a new key at: {keyUrl}',
      'Update your key: teamclaw config set providers.{provider}.apiKey YOUR_KEY',
      'Test the connection: teamclaw check',
    ],
  },
  RATE_LIMITED: {
    title: 'Rate limit reached for {provider}',
    body: 'You have sent too many requests. {provider} is asking us to slow down.',
    fix: [
      'Wait 60 seconds and try again',
      'Consider adding a fallback provider: teamclaw providers add',
      'Upgrade your {provider} plan for higher limits',
    ],
  },
  FIRST_CHUNK_TIMEOUT: {
    title: '{provider} is not responding',
    body: 'TeamClaw waited 15 seconds for a response but got nothing.',
    fix: [
      'Check your internet connection',
      'Try again — this is sometimes temporary',
      'Add a faster fallback provider',
    ],
  },
  ALL_PROVIDERS_FAILED: {
    title: 'All providers failed',
    body: 'TeamClaw tried all your configured providers and none responded.',
    fix: [
      'Run teamclaw check to see provider status',
      'Verify at least one API key is valid',
      'Check your internet connection',
    ],
  },
  NO_PROVIDERS_CONFIGURED: {
    title: 'No AI provider configured',
    body: 'TeamClaw needs an API key to work.',
    fix: [
      'Run teamclaw setup to configure a provider',
      'Or set: ANTHROPIC_API_KEY=sk-ant-... teamclaw work',
    ],
  },
  STREAM_FAILED: {
    title: 'Lost connection to {provider}',
    body: 'The response stream was interrupted before completing.',
    fix: [
      'Try again — this is usually temporary',
      'Check your internet connection',
      'If persistent, check {provider} status at {statusUrl}',
    ],
  },
  PROVIDER_ERROR: {
    title: '{provider} returned an error',
    body: 'The provider could not process the request.',
    fix: [
      'Try again in a moment',
      'Check {provider} status at {statusUrl}',
      'Run teamclaw check to verify your setup',
    ],
  },
};

function replacePlaceholders(text: string, vars: Record<string, string>): string {
  let result = text;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
  }
  return result;
}

export function formatError(code: string, provider: string, technicalDetail?: string): string {
  const template = ERROR_MESSAGES[code] ?? ERROR_MESSAGES['PROVIDER_ERROR'];
  const urls = PROVIDER_URLS[provider] ?? PROVIDER_URLS['custom'];

  const vars: Record<string, string> = {
    provider,
    keyUrl: urls.keyUrl ?? 'N/A',
    statusUrl: urls.statusUrl,
  };

  const title = replacePlaceholders(template.title, vars);
  const body = replacePlaceholders(template.body, vars);
  const fixes = template.fix.map((f) => replacePlaceholders(f, vars));

  const lines: string[] = [
    `${pc.red('✗')} ${pc.red(title)}`,
    '',
    body,
    '',
    'How to fix:',
    ...fixes.map((f, i) => `  ${i + 1}. ${f}`),
  ];

  if (technicalDetail) {
    lines.push('', `Technical detail: ${pc.dim(technicalDetail)}`);
  }

  return lines.join('\n');
}

export function formatFirstRunMessage(): string {
  const lines: string[] = [
    `${pc.red('✗')} TeamClaw is not configured yet.`,
    '',
    'Run setup first:',
    '  teamclaw setup',
    '',
    'Or quick start with just an API key:',
    '  export ANTHROPIC_API_KEY=sk-ant-...',
    '  teamclaw work --goal "your goal"',
  ];

  return lines.join('\n');
}
