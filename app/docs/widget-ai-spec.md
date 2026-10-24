# Especificação de componentes para o USB LCD

Vais criar um **componente** para um pequeno LCD ligado por USB a um PC. Um
componente é uma página HTML que mostra dados de sensores do PC (temperaturas,
cargas, consumos, relógio, etc.). Na app, o utilizador junta componentes num
ecrã (a que a app chama "widget"), posiciona-os e configura-os. A app desenha
tudo e envia os pixels para o LCD. Se o pedido for um ecrã inteiro, faz um
componente que ocupe o ecrã todo (o tamanho está na secção 7).

Neste documento, "widget" e "componente" querem dizer a mesma coisa: o
ficheiro que vais escrever.

Responde **apenas com um ficheiro HTML completo**, dentro de um único bloco
```html. Não acrescentes explicações antes nem depois, porque o utilizador vai
colar a resposta diretamente na app.

## 1. Formato do ficheiro

O ficheiro tem obrigatoriamente:

1. Um manifest JSON embutido em
   `<script type="application/json" id="widget-manifest">…</script>`.
2. O SDK, carregado exatamente com
   `<script src="../_sdk/widget-sdk.js"></script>`.
3. O teu código, que regista `Widget.onUpdate(...)`.

### Manifest

```json
{
  "name": "Nome curto do widget",
  "description": "Uma frase sobre o que mostra.",
  "size": { "w": 200, "h": 120 },
  "properties": [
    { "key": "sensor", "type": "sensor", "label": "Sensor" },
    { "key": "label",  "type": "text",   "label": "Legenda", "default": "CPU" },
    { "key": "max",    "type": "number", "label": "Máximo", "default": 100, "min": 0, "max": 1000 },
    { "key": "color",  "type": "color",  "label": "Cor", "default": "#00c8ff" },
    { "key": "glow",   "type": "boolean","label": "Brilho", "default": true },
    { "key": "style",  "type": "select", "label": "Estilo", "default": "barras", "options": ["barras", "linha"] },
    { "key": "icon",   "type": "file",   "label": "Imagem" }
  ]
}
```

- `size` é o tamanho inicial em pixels. O utilizador pode redimensionar o
  widget, por isso o desenho tem de se adaptar a qualquer tamanho.
- `category` (opcional) é o grupo na paleta da app: `"component"` (por
  omissão, para widgets com dados), `"shape"` (decoração) ou `"image"`.
- `properties` define o formulário que o utilizador vê na app. Cada entrada
  tem `key`, `type` e `label`, e opcionalmente `default`.
- Tipos de propriedade:

| type | Valor que o widget recebe | Notas |
|---|---|---|
| `sensor` | objeto sensor (ver secção 3) ou `null` | o utilizador escolhe o sensor na app |
| `text` | string | |
| `number` | número | aceita `min` e `max` |
| `color` | string `"#rrggbb"` | usa sempre 6 dígitos hex |
| `boolean` | `true` / `false` | |
| `select` | uma das strings de `options` | `options` é obrigatório |
| `file` | URL `file:///…` de uma imagem, ou vazio | |

- Para cada dado que o widget mostra, cria uma propriedade `sensor`. Nunca
  escrevas IDs de sensores no código, porque é o utilizador que os escolhe.
- Expõe como propriedades as cores, as legendas e os limites (mínimo e máximo),
  sempre com valores por omissão sensatos.

## 2. Ambiente de execução

- Corre no Chromium (Electron), a partir de `file://`, **sem internet**. Não
  uses CDNs, fontes web, imagens remotas nem `fetch`. Põe todo o CSS e JS
  dentro do ficheiro. SVG inline e `<canvas>` funcionam bem.
- Fontes disponíveis: as do Windows (`"Segoe UI"`, `"Segoe UI Variable"`,
  `Consolas`, `"Cascadia Mono"`, `Bahnschrift`, `system-ui`). Para números
  usa `font-variant-numeric: tabular-nums`, para os dígitos não dançarem.
- O widget corre num iframe do tamanho do widget, com **fundo transparente**:
  - `html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: transparent; }`
  - O fundo da página é definido pelo utilizador (normalmente preto). Se
    quiseres um cartão com fundo, desenha-o dentro do widget e torna a sua cor
    configurável.
- Não acedas a `window.parent`, ao `localStorage` nem a APIs do sistema.

## 3. Dados: o SDK

```js
Widget.onUpdate((props, info) => {
  // props: valores das propriedades do manifest (com os defaults aplicados)
  // info.size: { width, height } — tamanho atual do widget em pixels
  // info.sensorSeq: número que muda a cada leitura nova dos sensores
  // info.lang: idioma da app ('en' ou 'pt'); Widget.locale(info) dá 'en-GB' ou 'pt-PT'
});
```

- O callback é chamado quando o widget carrega, a cada leitura dos sensores
  (normalmente uma vez por segundo) e sempre que o utilizador muda uma
  propriedade ou o tamanho. **Desenha tudo a partir de `props` e `info.size`
  de cada vez**, sem acumular estado entre chamadas.
- Uma propriedade `sensor` chega como:

```js
{
  id: "/amdcpu/0/temperature/2",
  name: "Core (Tctl/Tdie)",      // nome do sensor
  hardware: "AMD Ryzen 5 3600",  // dispositivo
  group: "Temperatures",
  type: "Temperature",           // Temperature, Load, Power, Clock, Fan, Data, Voltage, ...
  value: 57.5,                   // número ou null se não houver leitura
  unit: "°C",
  min: 41.0, max: 78.3,          // mínimo/máximo desde o arranque, podem ser null
  history: [55.1, 56.0, 57.5]    // últimas leituras (até 600), a mais recente no fim
}
```

  ou `null` se o utilizador ainda não escolheu um sensor ou se ele não existe.
  Trata sempre `null` e `value === null` mostrando `--`.
- Para gráficos históricos usa `sensor.history`, em vez de guardares valores tu.
- Funções auxiliares:
  - `Widget.format(sensor, decimals)`: devolve o valor com `decimals` casas
    decimais, ou `"--"`.
  - `Widget.fraction(value, min, max)`: devolve a posição do valor entre min e
    max, limitada a 0..1.
  - `Widget.mix(colorA, colorB, t)`: interpola duas cores `#rrggbb` pelo
    matiz (de azul para vermelho passa por verde e amarelo).

## 4. O ecrã e o desempenho (importante)

- O LCD tem poucas cores (RGB565, 65 mil) e uma densidade de 1 px = 1 pixel
  físico. Por isso:
  - Usa alto contraste sobre fundo escuro e texto com pelo menos **11 px**.
  - Prefere cores sólidas. Degradês suaves e sombras subtis ficam com bandas.
  - Evita linhas de 1 px muito ténues, porque desaparecem.
- Cada pixel que muda é enviado por USB (cerca de 0,5 MB/s no total). Pixels
  que não mudam não custam nada. Por isso:
  - Anima só quando os dados mudam. Transições CSS curtas (≤ 0,8 s) são boas.
  - **Não faças animações contínuas**: nada de `animation: … infinite`, ciclos
    de `requestAnimationFrame`, piscas ou partículas permanentes. Se uma
    animação contínua for mesmo pedida, limita-a a uma área pequena.
  - Para relógios, usa `setInterval` de 1 s ou mais e só altera o DOM quando o
    texto mudar.
- Ajusta tamanhos de letra e elementos a `info.size`, para que o widget fique
  bem tanto pequeno (ex: 100×50) como grande (ex: 240×200).
- A app pode ampliar o ecrã inteiro para um LCD maior: trabalha sempre nas unidades de
  `info.size` (o SDK amplia a página por ti). Se desenhares num `<canvas>`, obtém o contexto com
  `const ctx = Widget.canvas(canvas, info.size, info.scale);` em cada atualização, em vez de
  definires `canvas.width`, para ficar nítido.

## 5. Exemplo completo

```html
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<script type="application/json" id="widget-manifest">
{
  "name": "Anel de carga",
  "description": "Anel com a percentagem de um sensor e o nome por baixo.",
  "size": { "w": 120, "h": 120 },
  "properties": [
    { "key": "sensor", "type": "sensor", "label": "Sensor" },
    { "key": "label", "type": "text", "label": "Legenda", "default": "" },
    { "key": "min", "type": "number", "label": "Mínimo", "default": 0 },
    { "key": "max", "type": "number", "label": "Máximo", "default": 100 },
    { "key": "color", "type": "color", "label": "Cor", "default": "#00c8ff" },
    { "key": "colorHigh", "type": "color", "label": "Cor (alto)", "default": "#ff3b30" },
    { "key": "textColor", "type": "color", "label": "Cor do texto", "default": "#ffffff" }
  ]
}
</script>
<style>
  html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: transparent; }
  svg { width: 100%; height: 100%; display: block; }
  text { font-family: "Segoe UI", system-ui, sans-serif; font-variant-numeric: tabular-nums; }
  #ring { transition: stroke-dashoffset .6s ease, stroke .6s ease; }
</style>
</head>
<body>
<svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet">
  <circle cx="50" cy="50" r="40" fill="none" stroke="#2a2d33" stroke-width="10"/>
  <circle id="ring" cx="50" cy="50" r="40" fill="none" stroke-width="10" stroke-linecap="round"
          pathLength="100" stroke-dasharray="100" stroke-dashoffset="100" transform="rotate(-90 50 50)"/>
  <text id="value" x="50" y="54" text-anchor="middle" font-size="22" font-weight="600"></text>
  <text id="label" x="50" y="70" text-anchor="middle" font-size="9" fill="#9aa0a6"></text>
</svg>
<script src="../_sdk/widget-sdk.js"></script>
<script>
  const ring = document.getElementById('ring');
  const value = document.getElementById('value');
  const label = document.getElementById('label');

  Widget.onUpdate((p) => {
    const v = p.sensor ? p.sensor.value : null;
    const f = Widget.fraction(v, Number(p.min), Number(p.max));
    ring.setAttribute('stroke-dashoffset', (100 - f * 100).toFixed(1));
    ring.setAttribute('stroke', Widget.mix(p.color, p.colorHigh, f));
    value.setAttribute('fill', p.textColor);
    value.textContent = Widget.format(p.sensor, 0) + (p.sensor && v != null ? p.sensor.unit : '');
    label.textContent = p.label || (p.sensor ? p.sensor.name : '');
  });
</script>
</body>
</html>
```

## 6. Lista de verificação antes de responderes

- [ ] Um único ficheiro HTML num bloco ```html, sem texto à volta.
- [ ] Tem `<script type="application/json" id="widget-manifest">` com JSON
      válido (sem comentários nem vírgulas a mais).
- [ ] Tem `<script src="../_sdk/widget-sdk.js"></script>` antes do teu código.
- [ ] Não usa recursos externos.
- [ ] Fundo transparente; adapta-se a `info.size`.
- [ ] Trata sensores `null` e valores `null`.
- [ ] Não tem animações contínuas.
- [ ] Cores, legendas e limites são propriedades com `default`.
