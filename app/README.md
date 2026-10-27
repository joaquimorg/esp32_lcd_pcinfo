# USB LCD Widgets

App de PC que desenha widgets HTML e os envia por USB (ou, na CYD, por Wi-Fi)
para o LCD do ESP32 (firmware em `../src`). Só são enviadas as zonas do ecrã que
mudam, cada retângulo no formato mais pequeno entre raw, RLE, LZ4 e deflate,
sem perder qualidade: os pixels no LCD são exatamente os que o PC desenhou.

Um **widget** é um ecrã completo do LCD, composto por **componentes** (gauge,
valor, barra, gráfico, relógio, texto ou componentes próprios), **formas**
decorativas (linha, retângulo, círculo/elipse, arco, polígono/estrela) e
**imagens** (PNG e JPG, com transparência, GIF e WebP animados, SVG, BMP).

Documentação em inglês, com imagens: [README.md](../README.md) na raiz do projeto.

## Idioma

A app está em inglês (por omissão) e em português: **Definições → Idioma**. O
idioma aplica-se à janela, aos componentes incluídos, ao padrão de calibração,
à data do relógio, às instruções para a IA e ao ecrã de espera do LCD (a app
envia-o ao ESP32, que o guarda). Os textos estão em `src/i18n.js`; os dos
componentes, na secção `i18n.pt` de cada `manifest.json`.

## Os separadores

**Execução**
- A biblioteca de widgets mostra uma miniatura de cada um.
- Cada widget pode estar ativo ou inativo e tem a sua duração. Com mais de um
  ativo, rodam pela ordem da biblioteca (as setas mudam a ordem). Um clique na
  miniatura de um widget ativo mostra-o já no LCD.
- Na troca de widget há uma transição: nenhuma, desvanecer, deslizar ou
  empurrar (em 4 direções), ampliar, cortina, círculo ou aleatória. O tipo e a
  duração escolhem-se no painel **Transições**, ao lado. No Editor, cada widget pode ter a sua
  **Transição de entrada**. O widget anterior fica no LCD até o novo ter
  carregado. No editor e nas miniaturas não há transição. No LCD, uma
  transição de ecrã inteiro muda todos os pixels, por isso tem menos frames
  do que no PC.
- **Importar…** acrescenta widgets a partir de ficheiros `.lcdwidget`.
- Ao lado, o que está no LCD agora e a **transição** entre widgets.

**Editor**
- Escolhe o widget a editar. Enquanto editas, o LCD mostra esse widget e a
  rotação fica pausada.
- Arrasta e redimensiona componentes, e configura-os no inspetor. Ao arrastar,
  os lados e o centro do componente encaixam nos lados e centros dos outros
  componentes e do ecrã. Aparecem guias (magenta: outros componentes; amarelo
  tracejado: centro do ecrã) e uma etiqueta com a posição e o tamanho. Ao
  redimensionar, a largura e a altura também encaixam no tamanho de outros
  componentes. **Alt** desliga o encaixe. O inspetor tem ainda botões para
  centrar o componente no ecrã.
- A paleta **Adicionar componente** está dividida em Componentes, Formas e
  Imagens. Ao adicionar uma imagem, a app pede logo o ficheiro e cria o
  componente com o tamanho da imagem, reduzido se não couber no ecrã. O botão
  **Tamanho da imagem** do inspetor repõe esse tamanho.
- As formas têm cor, contorno, opacidade e, conforme a forma, gradiente,
  cantos arredondados, traço tracejado ou pontilhado, ângulos e número de lados.
- As imagens têm ajuste (`contain`, `cover`, `fill`, `none` = tamanho
  original), opacidade, rotação, cantos arredondados e modo pixelizado (para
  pixel art). Os GIF/WebP animados animam no LCD. Com **Animar** desligado,
  mostram só o primeiro frame. Cada frame de uma animação é enviado pela
  ligação (cabo ou Wi-Fi), por isso uma animação grande gasta débito: o limite é
  a ligação (CYD no cabo série ~0,15 MB/s, por Wi-Fi 0,3-0,65 MB/s, USB nativo
  ~0,5 MB/s). Com o deflate, um GIF de ecrã inteiro corre 32-36% mais depressa
  em todas as ligações (ver o README em inglês, secção Speed).
- Cria componentes novos com IA.
- **Exportar…** grava o widget num ficheiro `.lcdwidget`. **Importar…** abre
  um desses ficheiros para editar.

**Definições**
- Geral (idioma, arrancar com o Windows), sensores (LHM e intervalo), ligação
  ao ESP32 (porta e FPS máx.) e ecrã do LCD (área visível e calibração).

O ficheiro `.lcdwidget` é autocontido: leva o layout, os componentes próprios
(por exemplo, os feitos com IA) e as imagens. Os IDs dos sensores vão como
estão. Noutro PC, os sensores que não existirem mostram `--` até serem
escolhidos de novo no editor.

## Arrancar

```
cd app
npm install
npm start
```

Na primeira vez, o `npm start` descarrega o Electron se o `npm install` não o
tiver feito. Fechar a janela não termina a app: ela fica no tray (ícone de LCD)
e continua a atualizar o ecrã. Para sair, usa **Sair** no menu do tray.

Para usar sem o Node, gera o executável com `npm run dist`. Ficam em `dist/`:

- `USB-LCD-Widgets-Setup-<versão>.exe`: instalador para o utilizador atual (não pede administrador).
- `USB-LCD-Widgets-Portable-<versão>.exe`: corre sem instalar.

Os executáveis não estão assinados, por isso o Windows SmartScreen pode avisar
na primeira execução (**Mais informações → Executar mesmo assim**).

**Arrancar com o Windows** (em **Definições → Geral**) regista a app no arranque do
utilizador. Nesse caso, a app abre escondida no tray.

O ESP32 é encontrado automaticamente (VID Espressif + resposta ao HELLO). Se
houver mais do que uma placa, escolhe a porta em **Definições → Ligação ao ESP32**.
A lista mostra todas as portas série com o tipo, fabricante, VID:PID e se o LCD
está ligado nela, e avisa se a porta escolhida não pode ter o firmware do LCD.

Os sensores vêm do LibreHardwareMonitor (servidor web ligado, `data.json`) e
são identificados pelo `SensorId`, por isso não mudam quando acrescentas
hardware. Há também sensores próprios da app (`sys/cpu/load`, `sys/mem/load`,
`sys/mem/used`) que funcionam sem o LHM.

A configuração fica em `%APPDATA%\usb-lcd-widgets\config.json`.

## Tamanho do LCD (área visível)

Muitos painéis mostram só parte do controlador. Por exemplo, um painel de
240×280 ligado a um controlador de 240×320 com um desvio de 20 linhas. O
ESP32 reporta o tamanho do controlador, mas a parte visível pode ser menor.

Em **Definições → Ecrã do LCD**:

1. Liga **Padrão de calibração no LCD**. O LCD mostra o controlador inteiro
   com réguas numeradas em pixels e a área configurada contornada a verde.
2. Lê nas réguas a primeira e a última linha (e coluna) que vês no LCD.
3. Liga **Ajustar a área visível à mão** e preenche: Y = primeira linha,
   Altura = última − primeira + 1. Faz o mesmo para X e Largura, se for preciso.
4. Confirma que a linha verde se vê inteira e desliga o padrão.

Os widgets passam a ser desenhados para esse tamanho. No editor, componentes
que fiquem fora da área aparecem com contorno vermelho. A área também é
guardada no ESP32, para que o ecrã de espera fique centrado na parte visível.

## Ligação por Wi-Fi (CYD)

Em **Definições → Ligação ESP32**, *Ligação ao ecrã* pode ser *Cabo USB* ou
*Wi-Fi*. Com Wi-Fi, liga a CYD por USB uma vez, escreve a rede (2,4 GHz) e a
palavra-passe e carrega em **Configurar a placa**. A placa guarda-as na flash (a
app nunca guarda a palavra-passe), liga-se à rede e a app passa a falar com ela
por UDP, cerca de 2-3 vezes mais depressa que o cabo série. Os dois modos ficam
sempre disponíveis. Se a placa mudar de endereço, repete o passo. A ligação não é
cifrada: destina-se a uma rede local de confiança.

## Se o LCD deixar de responder

No ESP32-S2, fechar a porta USB com dados a meio (por exemplo, se a app for
terminada à força) pode deixar a comunicação USB presa. Há duas proteções:

- **Firmware:** se tiver respostas por enviar com a porta aberta e nada sair
  durante 1 s, o ESP32 reinicia sozinho.
- **App:** se a porta que já foi do ESP32 deixar de responder, a app pede um
  reinício (abre a porta a 2400 baud) e volta a ligar.
- **Firmware:** com a porta aberta, se nada chegar durante 10 s, o ESP32
  reinicia. A app manda um sinal por segundo, por isso isto só acontece se o
  USB do ESP32 encravar. Um monitor série aberto na porta sem enviar nada
  também o faz reiniciar.

A app envia cada frame em blocos de até 16 KB, um de cada vez. Assim o
buffer de receção do ESP32 nunca enche. Com o buffer cheio e respostas a sair
ao mesmo tempo, o USB do S2 encravava, por exemplo com GIFs. Ao ligar, o log
da app mostra porque o ESP32 reiniciou da última vez.

Em ambos os casos o LCD volta a funcionar ao fim de cerca de 10 s. Ao sair
normalmente, a app espera pelos dados pendentes antes de fechar a porta, para
não provocar este problema. A app só procura o ESP32 em portas Espressif com
USB nativo: as portas USB-Serial-JTAG (por exemplo, de um ESP32-S3) e o
bootloader são ignoradas, para não reiniciar outras placas ligadas.

## Ecrã de espera

Se o ESP32 passar 3 s sem receber dados, mostra "A aguardar dados do PC", com
um indicador animado, uma linha de estado do cabo e, na CYD, outra do Wi-Fi
(imagens reais do painel em [../docs/images/lcd-waiting-pt.png](../docs/images/lcd-waiting-pt.png)):

| Estado | Significado |
|---|---|
| Sem ligacao USB ao PC | o cabo só dá alimentação, ou o PC não reconheceu o dispositivo |
| Abre a app no PC | USB ligado, mas a app não tem a porta aberta |
| App ligada, sem dados | a app abriu a porta, mas não está a enviar |
| Wi-Fi nao configurado | ainda não foi dada nenhuma rede à placa (CYD) |
| Wi-Fi a ligar... | a placa está a entrar na rede |
| Wi-Fi 192.168.1.x  -55 dBm | ligada: endereço e intensidade do sinal (verde) |
| Wi-Fi: sem acesso a rede | palavra-passe errada, ou rede só de 5 GHz (vermelho) |

Mesmo sem alterações no ecrã, a app envia um sinal a cada segundo. Quando os
dados voltam, a app redesenha o ecrã completo automaticamente.

## Criar componentes com IA

No editor, painel **Criar componente com IA**:

1. **Copiar instruções**: copia a especificação ([docs/widget-ai-spec.md](docs/widget-ai-spec.md))
   com o tamanho do teu ecrã e os tipos de sensores deste PC. Cola-a numa
   conversa com uma IA (ChatGPT, Claude…) e escreve no fim o widget que queres,
   por exemplo: *"um velocímetro para a carga da GPU, com ponteiro e números grandes"*.
2. Copia a resposta da IA. Pode vir com texto à volta, porque a app extrai o HTML.
3. **Colar widget**: o widget é validado, guardado na pasta de widgets e
   acrescentado ao widget em edição. Se houver um erro (por exemplo, JSON
   inválido), a mensagem diz o que corrigir. Basta pedir à IA para corrigir
   e colar outra vez.

O formato é um único ficheiro HTML com o manifest embutido em
`<script type="application/json" id="widget-manifest">`. A especificação
completa está em `docs/widget-ai-spec.md`.

## Criar um componente à mão

Também podes escrever componentes diretamente. Usa **Adicionar componente → Pasta** para abrir a pasta de widgets do utilizador
(`%APPDATA%\usb-lcd-widgets\widgets`). Cada componente é uma pasta com dois ficheiros:

`manifest.json`
```json
{
  "name": "Temperatura",
  "description": "Mostra uma temperatura",
  "size": { "w": 120, "h": 60 },
  "properties": [
    { "key": "sensor", "type": "sensor", "label": "Sensor" },
    { "key": "color", "type": "color", "label": "Cor", "default": "#ffffff" }
  ]
}
```

Tipos de propriedade: `text`, `number` (com `min`/`max`), `color`, `boolean`,
`select` (com `options`), `sensor` e `file` (imagem do disco).

O campo opcional `category` escolhe o grupo da paleta: `component` (por
omissão), `shape` ou `image`. Um componente com uma propriedade `file` pede a
imagem logo ao ser adicionado.

Em vez do `manifest.json`, o manifest pode estar embutido no `widget.html`
(o formato que a IA usa).

`widget.html`
```html
<script src="../_sdk/widget-sdk.js"></script>
<div id="v"></div>
<script>
  Widget.onUpdate((props, { size }) => {
    document.getElementById('v').textContent = Widget.format(props.sensor, 1);
  });
</script>
```

As propriedades `sensor` chegam como objeto
`{ id, name, hardware, group, type, value, unit, min, max, history }`.
O SDK (`widgets/_sdk/widget-sdk.js`) também tem `Widget.fraction()`,
`Widget.mix()`, `Widget.opacity()` e `Widget.attrs()`. Os widgets incluídos em `widgets/` servem de exemplo.

Cada widget corre num iframe com fundo transparente. Depois de criares ou
alterares um widget, carrega em **Recarregar**. Os erros de JavaScript dos
widgets aparecem na consola onde correste o `npm start`.

## Estrutura

| Pasta | Conteúdo |
|---|---|
| `src/main` | Processo principal: ligação USB, codificação dos frames, sensores, configuração, rotação (`player.js`), `.lcdwidget` (`screens.js`), miniaturas |
| `src/display` | Página offscreen com o conteúdo do LCD (compõe os componentes) |
| `src/control` | Janela de gestão: `run.js` (Execução), `editor.js` (Editor) |
| `widgets` | Componentes incluídos e o SDK |
| `test` | Testes do protocolo (`npm test`) |

O protocolo está descrito em `../src/protocol.h`. Para medir o débito sem a
app, usa `python ../tools/usb_display_bench.py`.

## Licença

Copyright © 2026 [joaquim.org](https://joaquim.org). Licença MIT (ver [LICENSE](../LICENSE)).
