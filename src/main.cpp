/*
 * USB display — firmware de teste de débito.
 * Copyright (c) 2026 joaquim.org — MIT License (ver LICENSE).
 *
 * O ESP32 funciona como um ecrã "burro": recebe retângulos de pixels do PC por
 * USB CDC e escreve-os diretamente no LCD. O protocolo está em protocol.h e o
 * programa do lado do PC em app/ (e o benchmark em tools/usb_display_bench.py).
 *
 * Nota sobre o USB: o USBCDC do core Arduino (Serial) copia cada byte recebido
 * para uma fila FreeRTOS (xQueueSend byte a byte), o que limita bastante o
 * débito. Por isso este firmware é compilado com ARDUINO_USB_CDC_ON_BOOT=0 e
 * regista a sua própria interface CDC: o tud_cdc_rx_cb() abaixo corre na task
 * do TinyUSB e copia os dados em bloco para um ring buffer.
 *
 * Todas as leituras E escritas do TinyUSB são feitas dentro da task "usbd".
 * Chamar tud_cdc_n_read()/tud_cdc_n_write_flush() a partir da loopTask arma os
 * endpoints fora dessa task e, no S2, acaba por bloquear o USB (primeiro a
 * receção; depois as respostas deixavam de sair). A loopTask só usa os ring
 * buffers e pede à task usbd, com usbd_defer_func(), para os tratar.
 *
 * Sem Serial para logs: os erros são reportados ao PC através de RSP_ERROR.
 *
 * Placas sem USB nativo (ex: ESP32 CYD 2.8", ver platformio.ini): compila-se com
 * LCD_TRANSPORT_UART=1 e o mesmo protocolo corre na UART0, ligada ao chip
 * USB-série da placa, a UART_BAUD. Não há controlo de fluxo: a app só envia um
 * lote (<= 16 KB) de cada vez e espera pelo ACK, por isso o buffer de receção
 * (RX_RING_SIZE) nunca enche.
 */

#include <Arduino.h>
#include "lcd.h"
#include <Preferences.h>
#include "protocol.h"

#ifndef LCD_WIFI
#define LCD_WIFI 0
#endif
// PKT_RECT_Z: deflate, com o descodificador que já vem na ROM do ESP32 (11 KB de estado).
#ifndef LCD_DEFLATE
#define LCD_DEFLATE 0
#endif
#if LCD_DEFLATE
#include <rom/miniz.h>
#endif
// Cópia do ecrã na RAM para receber só a diferença entre frames (ver RECT_FLAG_XOR). TFT_eSPI.
#ifndef LCD_SHADOW
#define LCD_SHADOW 0
#endif
#define SHADOW_RESERVE (56 * 1024)   // RAM que fica livre para o resto (Wi-Fi, pilha, USB)
#define SHADOW_KEEP_BLOCK (12 * 1024)
#if LCD_WIFI
#include "wifi_link.h"
#endif

#ifndef LCD_TRANSPORT_UART
#define LCD_TRANSPORT_UART 0
#endif

#if !LCD_TRANSPORT_UART
#include "USB.h"
#include "esp32-hal-tinyusb.h"
#include "device/usbd_pvt.h"
#endif

#ifndef USBD_LCD_DMA
#define USBD_LCD_DMA 0
#endif

#if LCD_BACKEND_GFX && USBD_LCD_DMA
#error "USBD_LCD_DMA só existe com o TFT_eSPI"
#endif

#if ARDUINO_USB_CDC_ON_BOOT && !LCD_TRANSPORT_UART
#error "este firmware tem de compilar com ARDUINO_USB_CDC_ON_BOOT=0 (ver platformio.ini)"
#endif

#define CDC_ITF          0
#define CDC_EP_IN        0x84   // ver loadCdcDescriptor
#define RX_TIMEOUT_MS    500    // tempo máximo sem dados a meio de um pacote
#define CHUNK_PIXELS     4096   // pixels por bloco enviado para o LCD
#define RX_RING_SIZE     32768  // potência de 2
#define TX_RING_SIZE     2048   // potência de 2
#define IDLE_TIMEOUT_MS  3000   // sem pacotes durante este tempo -> ecrã de espera
#define SCREEN_OFF_MS    300000 // sem pacotes durante 5 min -> desliga o ecrã (AMOLED: evita burn-in)
#define RX_STALL_MS      10000  // porta aberta e nada recebido: USB encravado -> reinicia

static Lcd tft;
#ifdef WL_DEBUG
volatile uint32_t dbgLoopMs = 0, dbgPackets = 0, dbgErrors = 0;
#endif

static void onIdle();
static void onViewportChanged();
static void enterWaiting();

// Área visível do painel (pode ser menor que o controlador, ex: 240x280 com
// desvio de 20 linhas). Definida pela app e guardada na flash.
static struct { uint16_t x, y, w, h; } vp;
static Preferences prefs;
static uint8_t lang = LANG_EN;   // idioma do ecrã de espera (PKT_LANG, guardado na flash)
static uint8_t rotation = 0;     // rotação do LCD, x90° (PKT_ROTATION, guardada na flash)

static void loadRotation()
{
  prefs.begin("usblcd", true);
  rotation = prefs.getUChar("rot", 0) & 3;
  prefs.end();
}

static void saveRotation()
{
  prefs.begin("usblcd", false);
  prefs.putUChar("rot", rotation);
  prefs.remove("vp");   // a área visível guardada era da orientação anterior
  prefs.end();
}

static void loadViewport()
{
  vp = { 0, 0, (uint16_t)tft.width(), (uint16_t)tft.height() };
  prefs.begin("usblcd", true);
  if (prefs.getBytesLength("vp") == sizeof(vp)) prefs.getBytes("vp", &vp, sizeof(vp));
  lang = prefs.getUChar("lang", LANG_EN);
  prefs.end();
  if (lang >= LANG_COUNT) lang = LANG_EN;
  if (!vp.w || !vp.h || vp.x + vp.w > tft.width() || vp.y + vp.h > tft.height()) {
    vp = { 0, 0, (uint16_t)tft.width(), (uint16_t)tft.height() };
  }
}

static void saveLanguage()
{
  prefs.begin("usblcd", false);
  prefs.putUChar("lang", lang);
  prefs.end();
}

static void saveViewport()
{
  prefs.begin("usblcd", false);
  prefs.putBytes("vp", &vp, sizeof(vp));
  prefs.end();
}
static uint32_t screenEpoch = 0;   // ver AckReply::screenEpoch

// Causa do último esp_restart() pedido pelo firmware: sobrevive ao reinício
// (memória RTC não inicializada) e vai no HELLO para a app a registar.
#define RESTART_MAGIC 0x5EB00700u
static RTC_NOINIT_ATTR uint32_t rtcRestartCause;
static uint8_t bootResetReason, bootRestartCause;

static void restartFor(RestartCause cause)
{
  rtcRestartCause = RESTART_MAGIC | cause;
  esp_restart();
}

static void readRestartCause()
{
  bootResetReason = (uint8_t)esp_reset_reason();
  bootRestartCause = (rtcRestartCause & 0xFFFFFF00u) == RESTART_MAGIC ? (uint8_t)rtcRestartCause : RESTART_NONE;
  rtcRestartCause = 0;
}

static struct {
  uint32_t packets;
  uint32_t payloadBytes;
  uint32_t errors;
  uint32_t resyncBytes;
} stats;

/* ------------------------------------------------------------------------- */
/* Transporte                                                                */
/* ------------------------------------------------------------------------- */

#if LCD_TRANSPORT_UART

static uint32_t lastRxMs = 0;   // 0 = ainda não chegou nada

// De onde vieram os últimos bytes (e para onde vão as respostas). Com Wi-Fi há dois
// canais; um pacote vem sempre de um só (a app só usa um de cada vez).
enum { SRC_SERIAL, SRC_WIFI };
static uint8_t lastSrc = SRC_SERIAL;

static void transportBegin()
{
  Serial.setRxBufferSize(RX_RING_SIZE);   // antes do begin()
  Serial.begin(UART_BAUD);
}

// Lê exatamente n bytes. timeoutMs = 0 espera indefinidamente.
static bool rxRead(void* dst, size_t n, uint32_t timeoutMs = RX_TIMEOUT_MS)
{
  uint8_t* out = (uint8_t*)dst;
  uint32_t lastData = millis();

  while (n) {
#if LCD_WIFI
    // Sessão Wi-Fi nova: o que sobrou da anterior perde-se, e um pacote a meio falha já
    // (senão os bytes da sessão nova seriam lidos como pixels da antiga).
    if (wl::takeAbort() && timeoutMs) return false;
    // Uma perda no Wi-Fi demora a recuperar (retransmissão); a meio de um pacote não se desiste cedo.
    if (timeoutMs && lastSrc == SRC_WIFI) timeoutMs = max<uint32_t>(timeoutMs, 3000);
    // Só entre pacotes (à espera de cabeçalho) se aceita qualquer canal; a meio, o do pacote.
    if (!timeoutMs || lastSrc == SRC_WIFI) {
      size_t k = wl::read(out, n);
      if (k) {
        lastSrc = SRC_WIFI;
        out += k; n -= k;
        lastData = lastRxMs = millis();
        continue;
      }
    }
    if (!timeoutMs || lastSrc == SRC_SERIAL) {
#endif
    int avail = Serial.available();
    if (avail > 0) {
      size_t k = Serial.readBytes(out, min<size_t>(n, avail));
#if LCD_WIFI
      lastSrc = SRC_SERIAL;
#endif
      out += k; n -= k;
      lastData = lastRxMs = millis();
      continue;
    }
#if LCD_WIFI
    }
#endif

    uint32_t idle = millis() - lastData;
    if (timeoutMs && idle > timeoutMs) return false;
    if (!timeoutMs) onIdle();   // só entre pacotes (à espera de cabeçalho)
    feedLoopWDT();
#ifdef WL_DEBUG
    dbgLoopMs = millis();
#endif
    if (idle > 2) vTaskDelay(1);
  }
  return true;
}

static void txWrite(const void* data, size_t n)
{
#if LCD_WIFI
  if (lastSrc == SRC_WIFI) {
    wl::write(data, n);
    return;
  }
#endif
  Serial.write((const uint8_t*)data, n);
}

static void kickTx() {}

#else  // USB nativo

static void checkTxStall();

static uint16_t loadCdcDescriptor(uint8_t* dst, uint8_t* itf)
{
  uint8_t strIndex = tinyusb_add_string_descriptor("USB Display");
  uint8_t descriptor[TUD_CDC_DESC_LEN] = {
    TUD_CDC_DESCRIPTOR(*itf, strIndex, 0x85, 64, 0x03, 0x84, 64)
  };
  *itf += 2;
  memcpy(dst, descriptor, TUD_CDC_DESC_LEN);
  return TUD_CDC_DESC_LEN;
}

// Ring buffer: escrito só pela task usbd, lido só pela loopTask. Os índices
// são contadores livres (o wrap de u32 é natural).
static uint8_t rxRing[RX_RING_SIZE];
static volatile uint32_t rxWr = 0, rxRd = 0;
static volatile bool rxStalled = false;    // ring cheio, ficaram dados no TinyUSB
static volatile bool drainQueued = false;
static uint32_t drainQueuedAt = 0;

// Corre na task usbd. Se o ring encher, os dados ficam na FIFO do TinyUSB e o
// endpoint não é rearmado: o host recebe NAK até haver espaço (controlo de fluxo).
static void drainUsb()
{
  for (;;) {
    uint32_t used = rxWr - __atomic_load_n(&rxRd, __ATOMIC_ACQUIRE);
    uint32_t space = RX_RING_SIZE - used;
    if (!space) break;
    uint32_t pos = rxWr & (RX_RING_SIZE - 1);
    uint32_t got = tud_cdc_n_read(CDC_ITF, rxRing + pos, min(space, RX_RING_SIZE - pos));
    if (!got) break;
    __atomic_store_n(&rxWr, rxWr + got, __ATOMIC_RELEASE);
  }
  rxStalled = tud_cdc_n_available(CDC_ITF) > 0;
}

static void deferredDrain(void*)
{
  drainQueued = false;
  drainUsb();
}

// Chamado pela loopTask depois de consumir: pede à task usbd que continue a
// esvaziar o TinyUSB. Só fica um pedido pendente de cada vez para não encher
// a fila de eventos do TinyUSB.
static void kickDrain()
{
  if (RX_RING_SIZE - (__atomic_load_n(&rxWr, __ATOMIC_ACQUIRE) - rxRd) < 1024) return;
  // Há dados parados no TinyUSB? (normalmente o tud_cdc_rx_cb já os tirou)
  if (!rxStalled && !tud_cdc_n_available(CDC_ITF)) return;
  // Um pedido que se perdeu não pode bloquear a receção: repete ao fim de 50 ms.
  uint32_t now = millis();
  if (drainQueued && now - drainQueuedAt < 50) return;
  drainQueued = true;
  drainQueuedAt = now;
  usbd_defer_func(deferredDrain, NULL, false);
}

extern "C" void tud_cdc_rx_cb(uint8_t itf)
{
  if (itf == CDC_ITF) drainUsb();
}

// O upload do PlatformIO abre a porta a 1200 baud e fecha-a: reinicia no bootloader.
static void clearTx();

// Ao fechar a porta (DTR em baixo):
//   a 1200 baud reinicia no bootloader (upload do PlatformIO);
//   a 2400 baud reinicia normalmente (a app usa-o se o ESP32 deixar de responder);
//   de resto, descarta respostas por enviar (o próximo cliente não as quer).
extern "C" void tud_cdc_line_state_cb(uint8_t itf, bool dtr, bool rts)
{
  if (itf != CDC_ITF || dtr) return;
  cdc_line_coding_t coding;
  tud_cdc_n_get_line_coding(itf, &coding);
  if (coding.bit_rate == 1200) usb_persist_restart(RESTART_BOOTLOADER);
  if (coding.bit_rate == 2400) restartFor(RESTART_BY_APP);
  clearTx();
}

/*
 * Receção encravada: a app manda um SYNC por segundo enquanto tem a porta
 * aberta, por isso DTR ativo e nada recebido durante RX_STALL_MS quer dizer
 * que o USB do S2 encravou (já aconteceu com tráfego contínuo, ex: GIFs; o
 * Windows chega a dar o dispositivo como "não está a funcionar" e o reinício
 * a 2400 baud deixa de ser possível). Reiniciar é a única saída.
 */
static uint32_t lastRxMs = 0;

static void checkRxStall()
{
  if (!tud_cdc_n_connected(CDC_ITF)) {
    lastRxMs = millis();
    return;
  }
  if (millis() - lastRxMs >= RX_STALL_MS) restartFor(RESTART_RX_STALL);
}

// Lê exatamente n bytes. timeoutMs = 0 espera indefinidamente.
static bool rxRead(void* dst, size_t n, uint32_t timeoutMs = RX_TIMEOUT_MS)
{
  uint8_t* out = (uint8_t*)dst;
  uint32_t lastData = millis();

  while (n) {
    uint32_t avail = __atomic_load_n(&rxWr, __ATOMIC_ACQUIRE) - rxRd;
    if (avail) {
      uint32_t pos = rxRd & (RX_RING_SIZE - 1);
      uint32_t k = min<uint32_t>(n, min(avail, RX_RING_SIZE - pos));
      memcpy(out, rxRing + pos, k);
      __atomic_store_n(&rxRd, rxRd + k, __ATOMIC_RELEASE);
      out += k; n -= k;
      lastData = lastRxMs = millis();
      kickDrain();
      continue;
    }

    kickDrain();
    uint32_t idle = millis() - lastData;
    if (timeoutMs && idle > timeoutMs) return false;
    if (!timeoutMs) onIdle();   // só entre pacotes (à espera de cabeçalho)
    checkTxStall();
    checkRxStall();
    feedLoopWDT();
    if (idle > 2) {
      // Sem tráfego: liberta o CPU. Durante uma transferência os pacotes
      // chegam a cada poucos µs, por isso aí ficamos em polling.
      vTaskDelay(1);
    }
  }
  return true;
}

/* ---- Envio: a loopTask escreve no txRing, a task usbd passa-o ao TinyUSB ---- */

static uint8_t txRing[TX_RING_SIZE];
static volatile uint32_t txWr = 0, txRd = 0;   // txWr: loopTask; txRd: task usbd
static volatile bool txQueued = false;
static uint32_t txQueuedAt = 0;
static volatile uint32_t txCompletions = 0;   // incrementa a cada envio concluído

// Corre na task usbd.
static void pumpTx()
{
  for (;;) {
    uint32_t avail = __atomic_load_n(&txWr, __ATOMIC_ACQUIRE) - txRd;
    if (!avail) break;
    uint32_t pos = txRd & (TX_RING_SIZE - 1);
    uint32_t k = tud_cdc_n_write(CDC_ITF, txRing + pos, min(avail, TX_RING_SIZE - pos));
    if (!k) break;   // FIFO do TinyUSB cheia: continua no tud_cdc_tx_complete_cb
    __atomic_store_n(&txRd, txRd + k, __ATOMIC_RELEASE);
  }
  tud_cdc_n_write_flush(CDC_ITF);
}

// Corre na task usbd.
static void clearTx()
{
  __atomic_store_n(&txRd, __atomic_load_n(&txWr, __ATOMIC_ACQUIRE), __ATOMIC_RELEASE);
  tud_cdc_n_write_clear(CDC_ITF);
}

static void deferredTx(void*)
{
  txQueued = false;
  pumpTx();
}

extern "C" void tud_cdc_tx_complete_cb(uint8_t itf)
{
  if (itf != CDC_ITF) return;
  txCompletions++;
  pumpTx();
}

/*
 * Envio preso: se o PC fecha a porta com uma resposta a meio de ser enviada,
 * o endpoint IN do S2 (driver DWC2 do TinyUSB) pode ficar ocupado para sempre
 * e nada mais sai, mesmo depois de a porta ser reaberta. Fechar e reabrir o
 * endpoint não resolve (o driver não liberta a FIFO e a receção deixa de
 * funcionar), por isso, se houver dados por enviar com a porta aberta e
 * nenhum envio concluído durante 1 s, o ESP32 reinicia; a app volta a ligar.
 */
static void checkTxStall()
{
  static uint32_t since = 0, seenCompletions = 0;
  uint32_t now = millis();
  bool pending = txWr != __atomic_load_n(&txRd, __ATOMIC_ACQUIRE) || usbd_edpt_busy(0, CDC_EP_IN);

  if (!pending || !tud_cdc_n_connected(CDC_ITF) || txCompletions != seenCompletions) {
    seenCompletions = txCompletions;
    since = now;
    return;
  }
  if (now - since >= 1000) restartFor(RESTART_TX_STALL);
}

static void kickTx()
{
  uint32_t now = millis();
  if (txQueued && now - txQueuedAt < 50) return;   // um pedido perdido não bloqueia o envio
  txQueued = true;
  txQueuedAt = now;
  usbd_defer_func(deferredTx, NULL, false);
}

// Copia para o txRing. Se o PC não estiver a ler, desiste ao fim de 100 ms.
static void txWrite(const void* data, size_t n)
{
  // Porta fechada: ninguém lê a resposta, e dados por enviar ao fechar são o
  // que deixa o envio preso (ver checkTxStall).
  if (!tud_cdc_n_connected(CDC_ITF)) return;
  const uint8_t* p = (const uint8_t*)data;
  uint32_t start = millis();
  while (n) {
    uint32_t space = TX_RING_SIZE - (txWr - __atomic_load_n(&txRd, __ATOMIC_ACQUIRE));
    if (!space) {
      if (millis() - start >= 100) return;
      kickTx();
      vTaskDelay(1);
      continue;
    }
    uint32_t pos = txWr & (TX_RING_SIZE - 1);
    uint32_t k = min<uint32_t>(n, min(space, TX_RING_SIZE - pos));
    memcpy(txRing + pos, p, k);
    __atomic_store_n(&txWr, txWr + k, __ATOMIC_RELEASE);
    p += k; n -= k;
  }
}

#endif  // LCD_TRANSPORT_UART

static void sendReply(uint8_t type, const void* payload, uint16_t len)
{
  uint8_t hdr[5] = { PROTO_MAGIC0, PROTO_MAGIC1, type, (uint8_t)len, (uint8_t)(len >> 8) };
  txWrite(hdr, sizeof(hdr));
  if (len) txWrite(payload, len);
  kickTx();
}

static void sendError(ErrorCode code, uint8_t packetType)
{
  stats.errors++;
#ifdef WL_DEBUG
  dbgErrors = stats.errors;
#endif
  ErrorReply e = { code, packetType };
  sendReply(RSP_ERROR, &e, sizeof(e));
}

// Procura o magic e lê o resto do cabeçalho.
static bool readHeader(PacketHeader& h)
{
  uint8_t b;
  bool gotMagic0 = false;
  for (;;) {
    rxRead(&b, 1, 0);
    if (gotMagic0 && b == PROTO_MAGIC1) break;
    if (gotMagic0) stats.resyncBytes++;
    gotMagic0 = (b == PROTO_MAGIC0);
    if (!gotMagic0) stats.resyncBytes++;
  }
  h.magic0 = PROTO_MAGIC0;
  h.magic1 = PROTO_MAGIC1;
  return rxRead(&h.type, sizeof(h) - 2);
}

/* ------------------------------------------------------------------------- */
/* Saída para o LCD                                                          */
/* ------------------------------------------------------------------------- */

/*
 * LZ4: o retângulo comprimido (<= LZ4_BUF bytes) é lido para lzIn e descomprimido de uma vez
 * para lzOut, que segue para o LCD. Os pacotes que a app envia já têm w*h <= LZ4_MAX_PIXELS.
 * lzOut serve também de buffer dos pacotes RAW/RLE (nunca se tratam dois ao mesmo tempo):
 * poupa-se 8 KB de RAM, que é o que decide quantas linhas do ecrã a shadow consegue copiar.
 */
#define LZ4_BUF (LZ4_MAX_PIXELS * 2)
static uint8_t lzIn[LZ4_BUF];
alignas(4) static uint8_t lzOut[LZ4_BUF];   // alinhado a 4 bytes (pushPixels lê u32)

#if USBD_LCD_DMA
// Dois buffers: enquanto um vai por DMA para o LCD, o outro recebe do USB.
static uint16_t* chunkBuf[2];
static uint8_t chunkIdx = 0;
#else
static uint16_t* const chunkStorage = (uint16_t*)lzOut;
static_assert(CHUNK_PIXELS * 2 <= LZ4_BUF, "chunk maior que lzOut");
#endif

#if LCD_SHADOW
/*
 * Shadow: cópia na RAM das primeiras linhas do LCD, tal como estão no painel (mesmos bytes que
 * se enviam). É o que permite receber só a diferença para o frame anterior (RECT_FLAG_XOR).
 * Cada pixel desenhado, por qualquer pacote, é copiado para aqui; a app só usa a diferença
 * depois de ter desenhado o frame completo (como já fazia para os retângulos alterados).
 * Blocos de 3840 pixels = 16 linhas de 240 ou 12 de 320: uma linha nunca atravessa dois blocos.
 */
#define SHADOW_CHUNK_PX 3840
#define SHADOW_MAX_CHUNKS 80
static uint16_t* shadowChunk[SHADOW_MAX_CHUNKS];
static uint8_t shadowChunks = 0;

static uint16_t shadowRows()
{
  uint32_t w = tft.width();
  if (!w || SHADOW_CHUNK_PX % w) return 0;
  return (uint16_t)min<uint32_t>(tft.height(), (uint32_t)shadowChunks * SHADOW_CHUNK_PX / w);
}

// Fica com a RAM que sobrar, deixando `reserve` bytes livres para o resto (Wi-Fi, USB...). Também
// tem de sobrar um bloco grande: sem ele a memória livre fica em bocados de 1 KB onde o lwip e o
// AsyncUDP já não conseguem alocar os buffers de um datagrama (medido: perdia-se quase tudo).
static void shadowInit(uint32_t reserve)
{
  const uint32_t bytes = SHADOW_CHUNK_PX * 2;
  uint32_t need = (uint32_t)tft.width() * tft.height();
  while (shadowChunks < SHADOW_MAX_CHUNKS && (uint32_t)shadowChunks * SHADOW_CHUNK_PX < need) {
    if (ESP.getFreeHeap() < reserve + bytes || heap_caps_get_largest_free_block(MALLOC_CAP_8BIT) < bytes + SHADOW_KEEP_BLOCK) break;
    uint16_t* p = (uint16_t*)heap_caps_malloc(bytes, MALLOC_CAP_8BIT);
    if (!p) break;
    memset(p, 0, bytes);
    shadowChunk[shadowChunks++] = p;
  }
}

static inline uint16_t* shadowAt(uint32_t y, uint32_t x)
{
  uint32_t idx = y * tft.width() + x;
  return shadowChunk[idx / SHADOW_CHUNK_PX] + idx % SHADOW_CHUNK_PX;
}

// Copia n pixels (já na ordem do LCD) para a linha y, a partir de x.
static inline void shadowStoreRun(uint32_t y, uint32_t x, const uint16_t* src, uint32_t n)
{
  if (y < shadowRows()) memcpy(shadowAt(y, x), src, n * 2);
}

// Pixels [idx, idx+n) de um retângulo (x, y, w) que chegam em sequência, linha a linha.
static void shadowStoreStream(int rx, int ry, int rw, uint32_t idx, const uint16_t* src, uint32_t n)
{
  while (n) {
    uint32_t row = idx / rw, col = idx % rw, k = min<uint32_t>(n, rw - col);
    shadowStoreRun(ry + row, rx + col, src, k);
    src += k; idx += k; n -= k;
  }
}

static void shadowFill(int x, int y, int w, int h, uint16_t color)
{
  const uint16_t v = __builtin_bswap16(color);   // os bytes que o LCD recebe: alto primeiro
  const uint32_t rows = shadowRows();
  for (int yy = y; yy < y + h && (uint32_t)yy < rows; yy++) {
    uint16_t* p = shadowAt(yy, x);
    for (int xx = 0; xx < w; xx++) p[xx] = v;
  }
}

// O ecrã de espera e o resto do que o próprio firmware desenha não passam pela shadow: a app
// refaz o ecrã todo (screenEpoch) quando isso acontece, e é aí que volta a ficar certa.
#else
static inline uint16_t shadowRows() { return 0; }
#endif
static uint16_t* outBuf;
static size_t outFill;
#if LCD_SHADOW
static int sinkX, sinkY, sinkW;
static uint32_t sinkIdx;   // pixels do retângulo já enviados
#endif

static void sinkBegin(int x, int y, int w, int h)
{
#if LCD_SHADOW
  sinkX = x; sinkY = y; sinkW = w; sinkIdx = 0;
#endif
  tft.startWrite();
#if USBD_LCD_DMA
  tft.dmaWait();
  outBuf = chunkBuf[chunkIdx];
#else
  outBuf = chunkStorage;
#endif
  tft.setAddrWindow(x, y, w, h);
  outFill = 0;
}

static void sinkFlush()
{
  if (!outFill) return;
#if LCD_SHADOW
  shadowStoreStream(sinkX, sinkY, sinkW, sinkIdx, outBuf, outFill);
  sinkIdx += outFill;
#endif
#if USBD_LCD_DMA
  tft.pushPixelsDMA(outBuf, outFill);
  chunkIdx ^= 1;
  outBuf = chunkBuf[chunkIdx];
#else
  tft.pushPixels(outBuf, outFill);
#endif
  outFill = 0;
}

static void sinkEnd()
{
  sinkFlush();
#if USBD_LCD_DMA
  tft.dmaWait();
#endif
  tft.endWrite();
}

static void skipPayload(uint32_t n)
{
  static uint8_t trash[512];
  while (n) {
    uint32_t k = min<uint32_t>(n, sizeof(trash));
    if (!rxRead(trash, k)) return;
    n -= k;
  }
}

/* ------------------------------------------------------------------------- */
/* Pacotes                                                                   */
/* ------------------------------------------------------------------------- */

static bool rectValid(const PacketHeader& h)
{
  return h.w && h.h && h.x + h.w <= tft.width() && h.y + h.h <= tft.height();
}

static bool handleRaw(const PacketHeader& h)
{
  uint32_t pixels = (uint32_t)h.w * h.h;
  if (!rectValid(h) || h.len != pixels * 2) {
    sendError(rectValid(h) ? ERR_BAD_LEN : ERR_BAD_RECT, h.type);
    skipPayload(h.len);
    return true;
  }

  bool ok = true;
  sinkBegin(h.x, h.y, h.w, h.h);
  while (pixels) {
    uint32_t k = min<uint32_t>(pixels, CHUNK_PIXELS - outFill);
    if (!rxRead(outBuf + outFill, k * 2)) { ok = false; break; }
    outFill += k;
    pixels -= k;
    if (outFill == CHUNK_PIXELS) sinkFlush();
  }
  sinkEnd();
  return ok;
}

static bool handleRle(const PacketHeader& h)
{
  if (!rectValid(h)) {
    sendError(ERR_BAD_RECT, h.type);
    skipPayload(h.len);
    return true;
  }

  uint32_t pixels = (uint32_t)h.w * h.h;
  uint32_t inLeft = h.len;
  bool ok = true, decodeError = false;

  sinkBegin(h.x, h.y, h.w, h.h);
  while (inLeft && pixels) {
    uint8_t c;
    if (!rxRead(&c, 1)) { ok = false; break; }
    inLeft--;

    uint32_t n = (c & 0x7F) + 1;
    uint32_t need = (c & 0x80) ? 2 : n * 2;
    if (n > pixels || need > inLeft) { decodeError = true; break; }
    inLeft -= need;
    pixels -= n;

    if (c & 0x80) {
      uint16_t px;
      if (!rxRead(&px, 2)) { ok = false; break; }
      while (n) {
        uint32_t k = min<uint32_t>(n, CHUNK_PIXELS - outFill);
        for (uint32_t i = 0; i < k; i++) outBuf[outFill + i] = px;
        outFill += k; n -= k;
        if (outFill == CHUNK_PIXELS) sinkFlush();
      }
    } else {
      while (n) {
        uint32_t k = min<uint32_t>(n, CHUNK_PIXELS - outFill);
        if (!rxRead(outBuf + outFill, k * 2)) { ok = false; break; }
        outFill += k; n -= k;
        if (outFill == CHUNK_PIXELS) sinkFlush();
      }
      if (!ok) break;
    }
  }
  sinkEnd();

  if (!ok) return false;
  if (decodeError || pixels) sendError(ERR_RLE_DECODE, h.type);
  skipPayload(inLeft);
  return true;
}


// Descomprime um bloco LZ4. Devolve o tamanho obtido, ou -1 se o bloco for inválido
// ou não couber em dstCap. Toda a leitura e escrita é verificada.
static int lz4Decode(const uint8_t* src, uint32_t srcLen, uint8_t* dst, uint32_t dstCap)
{
  const uint8_t* s = src;
  const uint8_t* const sEnd = src + srcLen;
  uint8_t* d = dst;
  uint8_t* const dEnd = dst + dstCap;

  while (s < sEnd) {
    uint8_t token = *s++;
    uint32_t lit = token >> 4;
    if (lit == 15) {
      uint8_t b;
      do {
        if (s >= sEnd) return -1;
        b = *s++;
        lit += b;
      } while (b == 255);
    }
    if (lit > (uint32_t)(sEnd - s) || lit > (uint32_t)(dEnd - d)) return -1;
    memcpy(d, s, lit);
    d += lit;
    s += lit;
    if (s >= sEnd) break;   // a última sequência só tem literais

    if (sEnd - s < 2) return -1;
    uint32_t off = s[0] | (s[1] << 8);
    s += 2;
    if (!off || off > (uint32_t)(d - dst)) return -1;

    uint32_t len = token & 15;
    if (len == 15) {
      uint8_t b;
      do {
        if (s >= sEnd) return -1;
        b = *s++;
        len += b;
      } while (b == 255);
    }
    len += 4;
    if (len > (uint32_t)(dEnd - d)) return -1;
    const uint8_t* m = d - off;
    while (len--) *d++ = *m++;   // byte a byte: o match pode sobrepor-se ao destino
  }
  return d - dst;
}

#if LCD_DEFLATE
static tinfl_decompressor inflator;

// Descomprime um fluxo deflate (raw) para dst, que tem de caber o resultado inteiro. Devolve o
// tamanho obtido ou -1 se o fluxo for inválido, incompleto ou não couber.
static int zDecode(const uint8_t* src, uint32_t srcLen, uint8_t* dst, uint32_t dstCap)
{
  tinfl_init(&inflator);
  size_t in = srcLen, out = dstCap;
  tinfl_status st = tinfl_decompress(&inflator, src, &in, dst, dst, &out, TINFL_FLAG_USING_NON_WRAPPING_OUTPUT_BUF);
  return st == TINFL_STATUS_DONE ? (int)out : -1;
}
#else
static int zDecode(const uint8_t*, uint32_t, uint8_t*, uint32_t) { return -1; }
#endif

// PKT_RECT_LZ4 e PKT_RECT_Z: mesmo tratamento, só muda o descompressor.
static bool handleCompressed(const PacketHeader& h)
{
  const bool z = h.type == PKT_RECT_Z;
  // RECT_FLAG_2X: os pixels do pacote são metade da largura e da altura (ver protocol.h).
  const bool x2 = (h.flags & RECT_FLAG_2X) != 0;
  const bool x2Ok = !x2 || (lcdCanUpscale(tft) &&!((h.x | h.y | h.w | h.h) & 1));
  // RECT_FLAG_XOR: o que chega é a diferença para o que já está no ecrã (ver protocol.h).
  const bool xr = (h.flags & RECT_FLAG_XOR) != 0;
  const bool xrOk = !xr || (!x2 && h.y + h.h <= shadowRows());
  uint32_t pixels = x2 ? (uint32_t)(h.w / 2) * (h.h / 2) : (uint32_t)h.w * h.h;
  if (!x2Ok || !xrOk || !rectValid(h) || pixels > LZ4_MAX_PIXELS || h.len > LZ4_BUF) {
    sendError(!x2Ok || !xrOk || !rectValid(h) || pixels > LZ4_MAX_PIXELS ? ERR_BAD_RECT : ERR_BAD_LEN, h.type);
    skipPayload(h.len);
    return true;
  }
  if (!rxRead(lzIn, h.len)) return false;
  const int got = z ? zDecode(lzIn, h.len, lzOut, pixels * 2) : lz4Decode(lzIn, h.len, lzOut, pixels * 2);
  if (got != (int)(pixels * 2)) {
    sendError(ERR_RLE_DECODE, h.type);
    return true;
  }

#if LCD_SHADOW
  if (xr) {   // diferença -> pixels novos, e a shadow passa a tê-los
    uint16_t* px = (uint16_t*)lzOut;
    for (int j = 0; j < h.h; j++) {
      uint16_t* sh = shadowAt(h.y + j, h.x);
      for (int i = 0; i < h.w; i++) { uint16_t v = px[j * h.w + i] ^ sh[i]; sh[i] = v; px[j * h.w + i] = v; }
    }
  } else if (!x2) {
    for (int j = 0; j < h.h; j++) shadowStoreRun(h.y + j, h.x, (uint16_t*)lzOut + j * h.w, h.w);
  }
#endif

  tft.startWrite();
#if USBD_LCD_DMA
  tft.dmaWait();
#endif
  tft.setAddrWindow(h.x, h.y, h.w, h.h);
  if (x2) {
    lcdPushPixels2x(tft, (uint16_t*)lzOut, h.w / 2, h.h / 2);
#if LCD_SHADOW
    // Cada pixel de origem são 4 no ecrã: a shadow tem de ter exatamente o que o LCD mostra.
    static uint16_t row[320];
    for (int j = 0; j < h.h / 2; j++) {
      const uint16_t* src = (const uint16_t*)lzOut + j * (h.w / 2);
      for (int i = 0; i < h.w / 2; i++) row[2 * i] = row[2 * i + 1] = src[i];
      shadowStoreRun(h.y + 2 * j, h.x, row, h.w);
      shadowStoreRun(h.y + 2 * j + 1, h.x, row, h.w);
    }
#endif
  } else {
    tft.pushPixels((uint16_t*)lzOut, pixels);
  }
  tft.endWrite();
  return true;
}

static bool handlePacket(const PacketHeader& h)
{
  switch (h.type) {
    case PKT_HELLO: {
      skipPayload(h.len);
      HelloReply r = { PROTO_VERSION, (uint16_t)tft.width(), (uint16_t)tft.height(),
                       (uint8_t)((USBD_LCD_DMA ? HELLO_FLAG_DMA : 0) | HELLO_FLAG_LZ4 | (lcdBuffered(tft) ? HELLO_FLAG_BUFFERED : 0) | (lcdCanUpscale(tft) ? HELLO_FLAG_UPSCALE : 0) | (lcdCanRotate(tft) ? HELLO_FLAG_ROTATE : 0) | (LCD_DEFLATE ? HELLO_FLAG_DEFLATE : 0)),
                       vp.x, vp.y, vp.w, vp.h, bootResetReason, bootRestartCause, lang,
                       (uint8_t)(LCD_TRANSPORT_UART ? TRANSPORT_UART : TRANSPORT_USB_CDC), LCD_ALIGN, rotation };
#if LCD_WIFI
      r.flags |= HELLO_FLAG_WIFI;
      if (lastSrc == SRC_WIFI) r.transport = TRANSPORT_WIFI;
      r.wifiState = wl::state();
      r.wifiRssi = wl::rssi();
      wl::ip(r.wifiIp);
#endif
      r.shadowRows = shadowRows();
      sendReply(RSP_HELLO, &r, sizeof(r));
      return true;
    }

    case PKT_RECT_RAW:
      return handleRaw(h);

    case PKT_RECT_RLE:
      return handleRle(h);

    case PKT_RECT_LZ4:
      return handleCompressed(h);

#if LCD_DEFLATE
    case PKT_RECT_Z:
      return handleCompressed(h);
#endif

    case PKT_FILL: {
      uint8_t c[2];
      if (h.len != 2 || !rectValid(h)) {
        sendError(h.len != 2 ? ERR_BAD_LEN : ERR_BAD_RECT, h.type);
        skipPayload(h.len);
        return true;
      }
      if (!rxRead(c, 2)) return false;
      lcdFillRect(tft, h.x, h.y, h.w, h.h, (c[0] << 8) | c[1]);
#if LCD_SHADOW
      shadowFill(h.x, h.y, h.w, h.h, (c[0] << 8) | c[1]);
#endif
      return true;
    }

    case PKT_SYNC: {
      AckReply r = {};
      if (h.len != 4) {
        sendError(ERR_BAD_LEN, h.type);
        skipPayload(h.len);
        return true;
      }
      if (!rxRead(&r.seq, 4)) return false;
      r.packets = stats.packets;
      r.payloadBytes = stats.payloadBytes;
      r.errors = stats.errors;
      r.resyncBytes = stats.resyncBytes;
      r.screenEpoch = screenEpoch;
      sendReply(RSP_ACK, &r, sizeof(r));
      // Primeiro o ACK (a app já pode mandar o lote seguinte); depois mostra o frame.
      if (!(h.flags & SYNC_HOLD)) lcdCommit(tft);
      return true;
    }

    case PKT_VIEWPORT:
      skipPayload(h.len);
      if (!rectValid(h)) {
        sendError(ERR_BAD_RECT, h.type);
        return true;
      }
      if (h.x != vp.x || h.y != vp.y || h.w != vp.w || h.h != vp.h) {
        vp = { h.x, h.y, h.w, h.h };
        saveViewport();
        onViewportChanged();
      }
      return true;

    case PKT_LANG:
      skipPayload(h.len);
      if (h.x >= LANG_COUNT) {
        sendError(ERR_BAD_RECT, h.type);
        return true;
      }
      if (h.x != lang) {
        lang = h.x;
        saveLanguage();
        onViewportChanged();   // redesenha o ecrã de espera, se estiver à vista
      }
      return true;

    case PKT_ROTATION:
      skipPayload(h.len);
      if (h.x > 3 || !lcdCanRotate(tft)) {
        sendError(ERR_BAD_RECT, h.type);
        return true;
      }
      if (h.x != rotation) {
        rotation = h.x;
        tft.setRotation(rotation);
        saveRotation();
        vp = { 0, 0, (uint16_t)tft.width(), (uint16_t)tft.height() };
        enterWaiting();   // redesenha o ecrã de espera e obriga a app a reenviar o frame
      }
      return true;

#if LCD_WIFI
    case PKT_WIFI_SET: {
      uint8_t b[2 + 32 + 64];
      // [u8 n][ssid n][u8 m][palavra-passe m]
      if (h.len < 2 || h.len > sizeof(b)) {
        sendError(ERR_BAD_LEN, h.type);
        skipPayload(h.len);
        return true;
      }
      if (!rxRead(b, h.len)) return false;
      uint8_t n = b[0];
      if (n > 32 || 1 + n >= h.len || b[1 + n] > 63 || 2u + n + b[1 + n] != h.len) {
        sendError(ERR_BAD_LEN, h.type);
        return true;
      }
      String ssid, pass;
      ssid.concat((const char*)b + 1, n);
      pass.concat((const char*)b + 2 + n, b[1 + n]);
      wl::configure(ssid, pass);
      return true;
    }
#endif

#ifdef LCD_CHECK
    case 0x7E: {   // diagnóstico: devolve o LCD, uma linha por resposta (0x8D: y u16 + pixels em big-endian)
      skipPayload(h.len);
      static uint16_t line[320];
      for (int y = 0; y < tft.height(); y++) {
        tft.readRect(0, y, tft.width(), 1, line);
        uint8_t hdr[2] = { (uint8_t)y, (uint8_t)(y >> 8) };
        uint8_t buf[2 + 640];
        memcpy(buf, hdr, 2);
        memcpy(buf + 2, line, tft.width() * 2);
        sendReply(0x8D, buf, 2 + tft.width() * 2);
      }
      return true;
    }
#endif
#ifdef LCD_CHECK
    case 0x7F: {   // diagnóstico: lê o LCD de volta e compara com a shadow
      skipPayload(h.len);
      static uint16_t row[320];
      uint32_t bad = 0, total = 0, rows = tft.height(), crc = 0xFFFFFFFF, sh = shadowRows();
      for (uint32_t y = 0; y < rows; y++) {
        tft.readRect(0, y, tft.width(), 1, row);
        for (int x = 0; x < tft.width(); x++) {
          total++;
#if LCD_SHADOW
          if (y < sh && row[x] != *shadowAt(y, x)) bad++;
#endif
          const uint8_t* b = (const uint8_t*)&row[x];
          for (int k = 0; k < 2; k++) { crc ^= b[k]; for (int j = 0; j < 8; j++) crc = (crc >> 1) ^ (0xEDB88320u & -(crc & 1)); }
        }
      }
      AckReply r = {};
      r.seq = bad; r.packets = total; r.payloadBytes = rows;
      r.errors = ~crc;
      sendReply(RSP_ACK, &r, sizeof(r));
      return true;
    }
#endif

    case PKT_SINK:
      skipPayload(h.len);
      return true;

    default:
      // Tipo desconhecido: ignoramos o payload declarado e continuamos.
      sendError(ERR_BAD_TYPE, h.type);
      skipPayload(h.len);
      return true;
  }
}

/* ------------------------------------------------------------------------- */

/* ------------------------------------------------------------------------- */
/* Ecrã de espera                                                            */
/* ------------------------------------------------------------------------- */

#define SPINNER_DOTS 10

static bool waiting = false;
static bool screenOff = false;   // ecrã desligado por falta de dados; acorda com o próximo pacote
static uint32_t lastPacketMs = 0;
static uint8_t waitStatus = 0xFF;
#if LCD_WIFI
static uint32_t waitWifiSig = 0xFFFFFFFF;
#endif
static uint8_t spinnerStep = 0;
static uint32_t spinnerMs = 0;

static uint16_t accentColor() { return tft.color565(58, 168, 255); }
static uint16_t dimColor()    { return tft.color565(45, 49, 56); }

// Posições do ecrã de espera, relativas à área visível (desenho base: 240x320).
static int waitX(int x) { return vp.x + x * vp.w / 240; }
static int waitY(int y) { return vp.y + y * vp.h / 320; }

static void drawSpinnerDot(int i, uint16_t color)
{
  float a = i * 2 * PI / SPINNER_DOTS - PI / 2;
  int r = min(48, vp.h / 11);
  tft.fillCircle(waitX(120) + cosf(a) * r, waitY(115) + sinf(a) * r, max(5, vp.h / 60), color);
}

// Ecrã de espera (desenho base 240x320, escalado à área visível):
//   cabeçalho, o spinner, "a aguardar dados do PC" e, por baixo, uma linha por ligação (cabo e, com
//   Wi-Fi, a rede com o IP e o sinal) a dizer o que falta, e a resolução.
static void drawWaitingScreen()
{
  int cx = waitX(120);
  tft.fillScreen(TFT_BLACK);
  tft.setTextDatum(MC_DATUM);

  tft.setTextColor(tft.color565(150, 156, 165), TFT_BLACK);
  tft.drawString("USB LCD WIDGETS", cx, waitY(18), 2);
  tft.fillRect(waitX(104), waitY(32), waitX(136) - waitX(104), max(2, vp.h / 160), accentColor());

  for (int i = 0; i < SPINNER_DOTS; i++) drawSpinnerDot(i, dimColor());

  tft.setTextColor(TFT_WHITE, TFT_BLACK);
  // As fontes do TFT_eSPI não têm acentos: os textos vão sem eles.
  static const char* const title[LANG_COUNT][2] = { { "Waiting for", "data from PC" }, { "A aguardar", "dados do PC" } };
  tft.drawString(title[lang][0], cx, waitY(180), 4);
  tft.drawString(title[lang][1], cx, waitY(180) + 30, 4);

  tft.setTextColor(tft.color565(90, 96, 105), TFT_BLACK);
  tft.drawString(String(vp.w) + " x " + String(vp.h), cx, vp.y + vp.h - 12, 2);
  lcdPresent(tft);
  waitStatus = 0xFF;
#if LCD_WIFI
  waitWifiSig = 0xFFFFFFFF;
#endif
}

// Linha de estado do cabo/PC: ajuda a perceber porque não chegam dados.
static void drawWaitingStatus(uint8_t status)
{
  static const char* const text[LANG_COUNT][3] = {
    { "No USB connection to PC", "Open the app on the PC", "App connected, no data" },
    { "Sem ligacao USB ao PC", "Abre a app no PC", "App ligada, sem dados" },
  };
  const uint16_t color[] = { TFT_RED, tft.color565(242, 184, 75), accentColor() };
  int y = waitY(246);
  tft.fillRect(vp.x, y - 10, vp.w, 20, TFT_BLACK);
  tft.setTextDatum(MC_DATUM);
  tft.setTextColor(color[status], TFT_BLACK);
  tft.drawString(text[lang][status], waitX(120), y, 2);
  lcdPresent(tft);
}

#if LCD_WIFI
// Linha do Wi-Fi: não configurado, a ligar, ligado (IP e sinal) ou sem rede.
static void drawWaitingWifi()
{
  static const char* const text[LANG_COUNT][4] = {
    { "Wi-Fi not set up", "Wi-Fi connecting...", "Wi-Fi", "Wi-Fi: cannot join network" },
    { "Wi-Fi nao configurado", "Wi-Fi a ligar...", "Wi-Fi", "Wi-Fi: sem acesso a rede" },
  };
  const uint8_t st = wl::state();
  uint8_t ip[4];
  wl::ip(ip);
  const uint16_t color[] = { tft.color565(90, 96, 105), tft.color565(242, 184, 75), tft.color565(76, 200, 120), TFT_RED };
  String s = text[lang][st];
  if (st == WSTATE_CONNECTED) s += " " + String(ip[0]) + "." + String(ip[1]) + "." + String(ip[2]) + "." + String(ip[3]) + "  " + String(wl::rssi()) + " dBm";
  int y = waitY(268);
  tft.fillRect(vp.x, y - 10, vp.w, 20, TFT_BLACK);
  tft.setTextDatum(MC_DATUM);
  tft.setTextColor(color[st], TFT_BLACK);
  tft.drawString(s, waitX(120), y, 2);
  lcdPresent(tft);
}

// Assinatura do que a linha mostra (o sinal em passos de 5 dBm: não se redesenha por 1 dBm).
static uint32_t wifiSignature()
{
  uint8_t ip[4];
  wl::ip(ip);
  return wl::state() | ((uint32_t)ip[3] << 8) | ((uint32_t)ip[2] << 16) | ((uint32_t)(uint8_t)(wl::rssi() / 5) << 24);
}
#endif

static void enterWaiting()
{
  waiting = true;
  screenEpoch++;
  drawWaitingScreen();
}

// A app mudou a área visível: se o ecrã de espera estiver à vista, redesenha-o.
static void onViewportChanged()
{
  if (waiting) drawWaitingScreen();
}

// Chamado enquanto o ESP32 espera pelo próximo pacote.
static void onIdle()
{
  uint32_t now = millis();
  lcdFlushStale(tft, now);   // a app morreu a meio de um frame: mostra o que chegou
  if (!waiting) {
    if (now - lastPacketMs < IDLE_TIMEOUT_MS) return;
    enterWaiting();
  }

  if (!screenOff && now - lastPacketMs >= SCREEN_OFF_MS) {
    lcdSleep(tft);
    screenOff = true;
  }
  if (screenOff) return;   // nada a desenhar com o ecrã desligado

#if LCD_TRANSPORT_UART
  // Sem USB nativo não se sabe se o cabo está ligado: só se vê se a app fala.
  uint8_t status = lastRxMs && now - lastRxMs < 2500 ? 2 : 1;
#else
  uint8_t status = !tud_mounted() ? 0 : !tud_cdc_n_connected(CDC_ITF) ? 1 : 2;
#endif
  if (status != waitStatus) {
    waitStatus = status;
    drawWaitingStatus(status);
  }
#if LCD_WIFI
  uint32_t sig = wifiSignature();
  if (sig != waitWifiSig) {
    waitWifiSig = sig;
    drawWaitingWifi();
  }
#endif

  if (now - spinnerMs >= 90) {
    spinnerMs = now;
    // Um "cometa" de três pontos a rodar.
    drawSpinnerDot((spinnerStep + SPINNER_DOTS - 3) % SPINNER_DOTS, dimColor());
    drawSpinnerDot((spinnerStep + SPINNER_DOTS - 2) % SPINNER_DOTS, tft.color565(30, 80, 125));
    drawSpinnerDot((spinnerStep + SPINNER_DOTS - 1) % SPINNER_DOTS, tft.color565(44, 124, 190));
    drawSpinnerDot(spinnerStep, accentColor());
    lcdPresent(tft);
    spinnerStep = (spinnerStep + 1) % SPINNER_DOTS;
  }
}

/* ------------------------------------------------------------------------- */

void setup()
{
  readRestartCause();
#if LCD_TRANSPORT_UART
  transportBegin();
#else
  // Ver nota no topo: interface CDC própria em vez do Serial.
  tinyusb_enable_interface(USB_INTERFACE_CDC, TUD_CDC_DESC_LEN, loadCdcDescriptor);
  USB.productName("USB Display");
#ifdef LCD_USB_PID
  USB.PID(LCD_USB_PID);   // o PID por omissão da placa (0x1001) é o do USB-Serial-JTAG: a app ignora-o
#endif
  USB.begin();
#endif

  tft.init();
  loadRotation();
  tft.setRotation(lcdCanRotate(tft) ? rotation : 0);
  tft.setSwapBytes(false);  // os pixels já chegam em big-endian
  loadViewport();

  // Se o loop() bloquear (ex: SPI), o ESP32 reinicia sozinho e a app volta a ligar.
  enableLoopWDT();

#if USBD_LCD_DMA
  for (int i = 0; i < 2; i++) {
    chunkBuf[i] = (uint16_t*)heap_caps_malloc(CHUNK_PIXELS * 2, MALLOC_CAP_DMA);
  }
  tft.initDMA();
#endif

#if LCD_WIFI
  wl::begin();
#endif
#if LCD_SHADOW
  shadowInit(SHADOW_RESERVE);   // depois do Wi-Fi: fica com o que sobrar
#endif

  enterWaiting();
}

void loop()
{
  PacketHeader h;
  if (!readHeader(h)) {
    sendError(ERR_RX_TIMEOUT, 0);
    return;
  }

  if (screenOff) {
    lcdWake(tft);
    screenOff = false;
  }
  if (!handlePacket(h)) {
    // O PC parou a meio do pacote: o LCD pode ficar com o retângulo parcial.
    sendError(ERR_RX_TIMEOUT, h.type);
    return;
  }
  stats.packets++;
#ifdef WL_DEBUG
  dbgPackets = stats.packets;
#endif
  stats.payloadBytes += h.len;
  lastPacketMs = millis();
  waiting = false;
}
