'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AiUsage, parseClaude, parseCodex, windowLabel, POLL_MS } = require('../src/main/ai-usage');
const { Sensors } = require('../src/main/sensors');

const CLAUDE = {
  five_hour: { utilization: 3.0, resets_at: '2026-11-17T15:49:59.905983+00:00' },
  seven_day: { utilization: 47.0, resets_at: '2026-11-18T05:59:59Z' },
  seven_day_opus: null,
};
const CODEX = {
  plan_type: 'go',
  rate_limit: {
    limit_reached: true,
    primary_window: { used_percent: 100, limit_window_seconds: 2592000, reset_after_seconds: 1756313, reset_at: 1796670436 },
    secondary_window: null,
  },
};

test('parseClaude: janela de 5 h e semanal', () => {
  const w = parseClaude(CLAUDE);
  assert.deepStrictEqual(w, [
    { key: 'primary', percent: 3, windowSec: 18000, resetAt: Date.parse('2026-11-17T15:49:59.905983+00:00') },
    { key: 'secondary', percent: 47, windowSec: 604800, resetAt: Date.parse('2026-11-18T05:59:59Z') },
  ]);
});

test('parseClaude: janela em falta é omitida', () => {
  assert.deepStrictEqual(parseClaude({ five_hour: null, seven_day: CLAUDE.seven_day }).map((w) => w.key), ['secondary']);
  assert.deepStrictEqual(parseClaude({}), []);
});

test('parseCodex: só a janela primária (plano Go, 30 dias)', () => {
  assert.deepStrictEqual(parseCodex(CODEX), [
    { key: 'primary', percent: 100, windowSec: 2592000, resetAt: 1796670436000 },
  ]);
  assert.deepStrictEqual(parseCodex({}), []);
});

test('windowLabel: horas abaixo de 48 h, dias acima', () => {
  assert.strictEqual(windowLabel(18000), '5h');
  assert.strictEqual(windowLabel(604800), '7d');
  assert.strictEqual(windowLabel(2592000), '30d');
});

function home({ claude, codex } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiusage-'));
  if (claude !== undefined) {
    fs.mkdirSync(path.join(dir, '.claude'));
    fs.writeFileSync(path.join(dir, '.claude', '.credentials.json'), typeof claude === 'string' ? claude : JSON.stringify(claude));
  }
  if (codex !== undefined) {
    fs.mkdirSync(path.join(dir, '.codex'));
    fs.writeFileSync(path.join(dir, '.codex', 'auth.json'), JSON.stringify(codex));
  }
  return dir;
}

const NOW = Date.parse('2026-11-17T12:00:00Z');
const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test('sem ficheiro de login: noLogin e sem pedidos', async () => {
  const calls = [];
  const ai = new AiUsage({ home: home(), now: () => NOW, fetch: async (...a) => { calls.push(a); return reply(200, {}); } });
  ai.configure({ claude: true, codex: true });
  await ai.poll('claude');
  await ai.poll('codex');
  assert.strictEqual(ai.status.claude.state, 'noLogin');
  assert.strictEqual(ai.status.codex.state, 'noLogin');
  assert.strictEqual(calls.length, 0);
});

test('Claude com o login expirado: expired e sem pedido', async () => {
  let called = false;
  const ai = new AiUsage({
    home: home({ claude: { claudeAiOauth: { accessToken: 'x', expiresAt: NOW - 1000 } } }),
    now: () => NOW,
    fetch: async () => { called = true; return reply(200, CLAUDE); },
  });
  ai.configure({ claude: true, codex: false });
  await ai.poll('claude');
  assert.strictEqual(ai.status.claude.state, 'expired');
  assert.strictEqual(called, false);
});

test('ficheiro de login a meio de ser escrito: error, sem rebentar', async () => {
  const ai = new AiUsage({ home: home({ claude: '{"claudeAiOauth":' }), now: () => NOW, fetch: async () => reply(200, CLAUDE) });
  ai.configure({ claude: true, codex: false });
  await ai.poll('claude');
  assert.strictEqual(ai.status.claude.state, 'error');
});

test('respostas válidas geram sensores com os cabeçalhos certos', async () => {
  const calls = [];
  const ai = new AiUsage({
    home: home({
      claude: { claudeAiOauth: { accessToken: 'tok-c', refreshToken: 'nao-usar', expiresAt: NOW + 3600e3 } },
      codex: { tokens: { access_token: 'tok-x', refresh_token: 'nao-usar', account_id: 'acc' } },
    }),
    now: () => NOW,
    fetch: async (url, opts) => { calls.push({ url, headers: opts.headers }); return reply(200, url.includes('anthropic') ? CLAUDE : CODEX); },
  });
  ai.configure({ claude: true, codex: true });
  await ai.poll('claude');
  await ai.poll('codex');
  assert.strictEqual(ai.status.claude.state, 'ok');
  assert.strictEqual(ai.status.codex.state, 'ok');

  const c = calls.find((x) => x.url === 'https://api.anthropic.com/api/oauth/usage');
  assert.strictEqual(c.headers.Authorization, 'Bearer tok-c');
  assert.strictEqual(c.headers['anthropic-beta'], 'oauth-2025-04-20');
  const x = calls.find((y) => y.url === 'https://chatgpt.com/backend-api/wham/usage');
  assert.strictEqual(x.headers.Authorization, 'Bearer tok-x');
  assert.strictEqual(x.headers['chatgpt-account-id'], 'acc');
  assert.ok(!JSON.stringify(calls).includes('nao-usar'), 'o refresh token nunca sai');

  const out = {};
  ai.read(out);
  assert.deepStrictEqual(Object.keys(out).sort(), ['ai/claude/primary', 'ai/claude/secondary', 'ai/codex/primary']);
  assert.deepStrictEqual(out['ai/claude/primary'], {
    id: 'ai/claude/primary', name: 'Claude Code · 5h', hardware: 'AI', group: 'Claude Code', type: 'Load',
    value: 3, unit: '%', min: 0, max: 100, resetAt: Date.parse(CLAUDE.five_hour.resets_at), windowSec: 18000,
  });
  assert.strictEqual(out['ai/codex/primary'].name, 'Codex · 30d');
  assert.strictEqual(out['ai/codex/primary'].group, 'Codex');
});

test('HTTP 429: error e a próxima consulta espera o dobro', async () => {
  const ai = new AiUsage({
    home: home({ codex: { tokens: { access_token: 't', account_id: 'a' } } }),
    now: () => NOW,
    fetch: async () => reply(429, {}),
  });
  ai.configure({ claude: false, codex: true });
  assert.strictEqual(await ai.poll('codex'), POLL_MS * 2);
  assert.strictEqual(ai.status.codex.state, 'error');
  assert.match(ai.status.codex.message, /429/);
  assert.strictEqual(await ai.poll('codex'), POLL_MS * 4);
  for (let i = 0; i < 6; i++) await ai.poll('codex');
  assert.strictEqual(await ai.poll('codex'), 600000, 'nunca mais de 10 min');
});

test('erro depois de dados: os sensores antigos mantêm-se', async () => {
  let status = 200;
  const ai = new AiUsage({
    home: home({ codex: { tokens: { access_token: 't', account_id: 'a' } } }),
    now: () => NOW,
    fetch: async () => reply(status, CODEX),
  });
  ai.configure({ claude: false, codex: true });
  await ai.poll('codex');
  status = 500;
  await ai.poll('codex');
  const out = {};
  ai.read(out);
  assert.ok(out['ai/codex/primary']);
});

test('desligar um serviço apaga os sensores e o estado passa a off', async () => {
  const ai = new AiUsage({
    home: home({ codex: { tokens: { access_token: 't', account_id: 'a' } } }),
    now: () => NOW,
    fetch: async () => reply(200, CODEX),
  });
  ai.configure({ claude: false, codex: true });
  await ai.poll('codex');
  ai.configure({ claude: false, codex: false });
  const out = {};
  ai.read(out);
  assert.deepStrictEqual(out, {});
  assert.strictEqual(ai.status.codex.state, 'off');
  ai.stop();
});

test('Sensors.tick junta os sensores das fontes extra', async () => {
  const s = new Sensors({ sources: [{ read: (out) => { out['ai/x/primary'] = { id: 'ai/x/primary', value: 1 }; } }] });
  s.configure({ lhmUrl: '', intervalMs: 1000, language: 'en' });
  await s.tick();
  assert.strictEqual(s.snapshot['ai/x/primary'].value, 1);
  assert.ok(s.snapshot['sys/mem/load']);
});
