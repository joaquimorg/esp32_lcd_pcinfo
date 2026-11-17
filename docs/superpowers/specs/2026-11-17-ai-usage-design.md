# Uso das subscrições de IA no LCD — desenho

Data: 2026-11-17 · Estado: para aprovação

## Intenção

Ver no LCD, de relance, quanto já se gastou das subscrições de IA (Claude Code e Codex/ChatGPT):
a utilização da janela curta e da semana e, quando alguma está no limite, **quando faz reset**.
É a primeira de outras fontes de dados além do LibreHardwareMonitor; o desenho deixa o caminho
aberto para mais fontes, mas só faz esta.

## Objetivos

- Sensores novos para cada serviço, com a % usada de cada janela e a hora de reset.
- Um widget novo "Uso de IA" que mostra um serviço com aspeto configurável.
- Interruptor por serviço nas Definições, com o estado (a funcionar / sem login / erro).

## Não-objetivos

- Custos, tokens gastos ou histórico por sessão.
- Limites por modelo do Claude (`seven_day_opus`, `seven_day_sonnet`) e créditos extra.
- Renovar logins: a app nunca renova nem escreve os tokens.
- Outras fontes de dados (ficam para depois).

## Anti-objetivos (falha mesmo que "funcione")

- Estragar o login do Claude Code ou do Codex (por renovar o token, por exemplo).
- Abusar dos servidores (consultas ao ritmo de 1 s dos sensores).
- Guardar ou registar tokens, o e-mail ou o id da conta (a resposta do Codex traz o e-mail).

## O que foi verificado (2026-11-17, neste PC)

| Serviço | Login lido de | Pedido | Resposta útil |
|---|---|---|---|
| Claude Code | `~/.claude/.credentials.json` → `claudeAiOauth.accessToken`, `expiresAt` | `GET https://api.anthropic.com/api/oauth/usage`, cabeçalhos `Authorization: Bearer <token>`, `anthropic-beta: oauth-2025-04-20` | `five_hour` e `seven_day`: `{ utilization (%), resets_at (ISO) }` |
| Codex | `~/.codex/auth.json` → `tokens.access_token`, `tokens.account_id` | `GET https://chatgpt.com/backend-api/wham/usage`, cabeçalhos `Authorization: Bearer <token>`, `chatgpt-account-id: <account_id>` | `rate_limit.primary_window` / `secondary_window`: `{ used_percent, limit_window_seconds, reset_at (epoch s) }`; `secondary_window` pode ser `null` |

Os dois responderam 200. **As janelas não são sempre 5h + semana**: no plano Codex "Go" há só
uma janela de 30 dias (`limit_window_seconds: 2592000`) e nenhuma secundária. Por isso o nome de
cada janela vem da duração real. Nenhum dos pedidos é uma API pública: podem mudar sem aviso.

## Abordagens consideradas

- **A. Só sensores** e usar a barra e o gauge que já existem. É simples, mas o reset aparece como
  minutos soltos e está sempre visível.
- **B. Sensores e um widget próprio** *(escolhida)*. O widget junta as duas janelas e só mostra o
  reset quando está no limite. Os sensores continuam a servir a barra e o gauge.
- **C. Sensores de texto.** Mexe no modelo de sensores que todos os widgets usam, e o ganho é pequeno.

## Desenho

### Fonte de dados (`src/main/ai-usage.js`, novo)

- Classe `AiUsage` com o seu próprio temporizador: consulta cada serviço ligado a cada **90 s**,
  e logo ao ligar o interruptor. Em erro HTTP 429 ou 5xx espera o dobro, até 10 min.
- Lê o ficheiro de login **em cada consulta**, porque o Claude Code e o Codex trocam os tokens.
  - Claude: se `expiresAt` já passou, não faz o pedido e fica com o estado "login expirado: abra o
    Claude Code".
  - Ficheiro inexistente: estado "sem login".
- Só para leitura: nunca usa o `refreshToken`, nunca escreve nos ficheiros, nunca regista tokens
  nem respostas completas.
- Funções puras para converter as respostas (testáveis sem rede): `parseClaude(json)` e
  `parseCodex(json)` → `[{ key: 'primary'|'secondary', percent, windowSec, resetAt (ms) }]`.
  Claude: `five_hour` → primary (18000 s), `seven_day` → secondary (604800 s).

### Sensores

`Sensors.tick()` junta os últimos valores do `AiUsage` à lista, como já faz com o sistema e o LHM:

```
ai/claude/primary    ai/claude/secondary    ai/codex/primary    ai/codex/secondary
{ id, name: "Claude Code · 5h", hardware: "IA", group: "Claude Code", type: "Load",
  value: 62, unit: "%", min: 0, max: 100,
  resetAt: 1763394599905, windowSec: 18000 }
```

Uma janela que o serviço não tem (como a secundária do Codex Go) não gera sensor. O nome curto da
janela vem de `windowSec`: abaixo de 48 h fica em horas ("5h"), acima em dias ("7d", "30d").
Os sensores aparecem no seletor do Editor, por isso a barra e o gauge podem usá-los.

### Ligar o widget a um serviço

Hoje um widget só recebe os sensores das propriedades `type: "sensor"`, escolhidos um a um. Propõe-se
um tipo de propriedade novo, **`sensorGroup`**:

- No Editor aparece como uma lista de escolha com as `options` do manifest
  (`ai/claude` → "Claude Code", `ai/codex` → "Codex").
- `display.js` resolve-o num objeto com todos os sensores cujo id começa por `<valor>/`:
  `props.service = { primary: {...}, secondary: {...} }`.

Fica genérico, para servir fontes futuras com vários valores.
Também é preciso acrescentá-lo a `PROPERTY_TYPES`, à validação dos manifests, à especificação dos
widgets por IA (`app/docs/widget-ai-spec*.md`) e ao SDK.

### Widget "Uso de IA" (`widgets/aiusage/`)

Propriedades (com tradução para PT no manifest):

| Chave | Tipo | Valores / omissão |
|---|---|---|
| `service` | sensorGroup | Claude Code (`ai/claude`) / Codex (`ai/codex`) |
| `style` | select | `bars` (omissão), `rings`, `compact` |
| `show` | select | `both` (omissão), `primary`, `secondary` |
| `label` | text | vazio = nome do serviço |
| `color` / `warnColor` / `limitColor` | color | `#00c8ff` / `#ffb300` / `#ff3b30` |
| `trackColor` / `textColor` | color | `#2a2d33` / `#d0d4da` |
| `warnAt` | number | 80 (%) |
| `resetFormat` | select | `relative` ("em 2h 15m", omissão), `clock` ("às 14:30"; com o dia se não for hoje), `both` |

Comportamento:
- Cada janela mostra o nome curto, a % e a barra ou anel. A cor muda de normal para aviso a partir
  de `warnAt` e para limite aos 100%.
- **Aos 100%** essa janela mostra o reset em vez da % (ou por baixo dela, no estilo Barras).
- Mostrar "Uso de IA" com só uma janela também funciona (Codex Go): ocupa o espaço todo.
- Sem dados: o nome do serviço e "sem dados".
- A contagem decrescente é calculada no widget a partir de `resetAt`, por isso avança entre consultas.

```
 Barras                 Anéis                  Compacto
┌────────────────────┐ ┌────────────────────┐ ┌────────────────────┐
│ Claude Code        │ │    Claude Code     │ │ Claude  5h 42%     │
│ 5h  ██████░░░  62% │ │   ╭───╮   ╭───╮    │ │         7d 18%     │
│ 7d  ██░░░░░░░  18% │ │   │62%│   │18%│    │ │                    │
│                    │ │   ╰───╯   ╰───╯    │ │                    │
└────────────────────┘ └────────────────────┘ └────────────────────┘
 No limite:  5h ███████████ LIMITE  ·  reset em 2h 15m
```

### Definições

Nova secção "Subscrições de IA" com um interruptor por serviço (`config.ai = { claude: false,
codex: false }`, **desligados por omissão**, porque usam os logins da pessoa) e, ao lado, o estado
atual: "a funcionar", "sem login", "login expirado: abra o Claude Code" ou a mensagem de erro.

## Testes

- `parseClaude` / `parseCodex` com as respostas reais acima (anonimizadas), incluindo
  `secondary_window: null` e janela a 100%.
- Nome curto da janela (5h, 7d, 30d) e formato do reset (relativo / hora / dia).
- Resolução de `sensorGroup` em `display.js`; validação do manifest com o tipo novo.
- Textos PT/EN completos (o teste de i18n já existente apanha falhas).
- Verificação real: correr a app com os dois serviços ligados e capturar o LCD.

## Decisões deixadas a quem implementa

- O desenho exato de cada estilo e os tamanhos por omissão do widget.
- A forma do `sensorGroup` no editor de propriedades, desde que siga o estilo das listas de escolha.
