#pragma once
#include <stdint.h>

/*
 * Protocolo USB display (v1) — PC -> ESP32 por USB CDC.
 * Tem de ficar em sincronia com app/src/main/protocol.js e tools/usb_display_bench.py.
 *
 * Pacote PC -> ESP32 (little-endian):
 *   [0]  magic0 0xA5
 *   [1]  magic1 0x5A
 *   [2]  type   (PKT_*)
 *   [3]  flags  (reservado, 0)
 *   [4]  x      u16
 *   [6]  y      u16
 *   [8]  w      u16
 *   [10] h      u16
 *   [12] len    u32  bytes de payload que se seguem
 *
 * Pixels: RGB565 em big-endian (byte alto primeiro), a ordem que o LCD espera,
 * para o ESP32 poder copiar diretamente para o SPI sem trocar bytes.
 *
 * PKT_RECT_LZ4: bloco LZ4 (formato de bloco, sem cabeçalho) dos w*h pixels em
 * big-endian, com w*h <= LZ4_MAX_PIXELS.
 *
 * PKT_RECT_RLE: sequência de tokens sobre os w*h pixels (linha a linha):
 *   c < 0x80  -> c+1 pixels literais seguem (2 bytes cada)
 *   c >= 0x80 -> (c & 0x7F)+1 repetições do pixel seguinte (2 bytes)
 *
 * Sem pacotes durante IDLE_TIMEOUT_MS (main.cpp) o ESP32 mostra o ecrã de
 * espera; o PC deve enviar SYNC periodicamente mesmo sem alterações.
 *
 * Resposta ESP32 -> PC:
 *   [0] 0xA5 [1] 0x5A [2] type (RSP_*) [3..4] len u16  [payload]
 */

#define PROTO_VERSION 3
#define PROTO_MAGIC0  0xA5
#define PROTO_MAGIC1  0x5A

// Velocidade da UART nas placas sem USB nativo (LCD_TRANSPORT_UART). A app não a
// pode saber pelo HELLO (ainda não há ligação), por isso tem de ficar igual em
// app/src/main/device.js (UART_BAUD) e tools/usb_display_bench.py.
#define UART_BAUD     921600

enum PacketType : uint8_t {
  PKT_HELLO    = 0x01,  // sem payload -> RSP_HELLO
  PKT_RECT_RAW = 0x02,  // payload: w*h*2 bytes
  PKT_RECT_RLE = 0x03,  // payload: stream RLE
  PKT_FILL     = 0x04,  // payload: 2 bytes cor
  PKT_SYNC     = 0x05,  // payload: u32 seq -> RSP_ACK depois de tudo desenhado
  PKT_SINK     = 0x06,  // payload descartado (teste de débito USB puro)
  PKT_VIEWPORT = 0x07,  // x,y,w,h = área visível do painel (sem payload);
                        // guardada na flash, usada pelo ecrã de espera
  PKT_LANG     = 0x08,  // x = idioma do ecrã de espera (LANG_*), sem payload;
                        // guardado na flash
  PKT_RECT_LZ4 = 0x09,  // payload: bloco LZ4 dos w*h pixels (big-endian);
                        // w*h <= LZ4_MAX_PIXELS. Só se HELLO.flags tiver HELLO_FLAG_LZ4
};

// Tamanho do buffer de descompressão do firmware; a app não envia retângulos maiores
// (LZ4_MAX_PIXELS em app/src/main/protocol.js).
#define LZ4_MAX_PIXELS 8192

#define HELLO_FLAG_DMA 0x01
#define HELLO_FLAG_LZ4 0x02

enum LcdLanguage : uint8_t {
  LANG_EN = 0,
  LANG_PT = 1,
  LANG_COUNT
};

enum ReplyType : uint8_t {
  RSP_HELLO = 0x81,
  RSP_ACK   = 0x85,
  RSP_ERROR = 0x8E,
};

enum ErrorCode : uint8_t {
  ERR_BAD_TYPE    = 1,
  ERR_BAD_RECT    = 2,
  ERR_BAD_LEN     = 3,
  ERR_RLE_DECODE  = 4,    // também usado para LZ4 corrompido
  ERR_RX_TIMEOUT  = 5,
};

#pragma pack(push, 1)
struct PacketHeader {
  uint8_t  magic0, magic1;
  uint8_t  type, flags;
  uint16_t x, y, w, h;
  uint32_t len;
};

struct HelloReply {
  uint8_t  version;
  uint16_t width, height; // tamanho do controlador do LCD
  uint8_t  flags;         // HELLO_FLAG_*: bit0 DMA ativo, bit1 aceita PKT_RECT_LZ4
  uint16_t vpX, vpY, vpW, vpH;  // v3: área visível guardada (PKT_VIEWPORT)
  uint8_t  resetReason;   // esp_reset_reason() do último arranque
  uint8_t  restartCause;  // RESTART_*: quem pediu o último esp_restart()
  uint8_t  lang;          // LANG_*: idioma do ecrã de espera (PKT_LANG)
  uint8_t  transport;     // TRANSPORT_*: como o ESP32 está ligado ao PC
};

enum Transport : uint8_t {
  TRANSPORT_USB_CDC = 0,  // USB nativo (ESP32-S2)
  TRANSPORT_UART    = 1,  // chip USB-série (CH340/CP210x), a UART_BAUD
};

enum RestartCause : uint8_t {
  RESTART_NONE     = 0,   // não foi o firmware (alimentação, watchdog, crash…)
  RESTART_TX_STALL = 1,   // checkTxStall: envio USB preso
  RESTART_BY_APP   = 2,   // a app abriu a porta a 2400 baud
  RESTART_RX_STALL = 3,   // porta aberta e nada recebido durante RX_STALL_MS
};

struct AckReply {
  uint32_t seq;
  uint32_t packets;
  uint32_t payloadBytes;
  uint32_t errors;
  uint32_t resyncBytes;   // bytes descartados à procura do magic
  uint32_t screenEpoch;   // muda quando o ESP32 desenha o seu próprio ecrã:
                          // o PC tem de reenviar o frame completo
};

struct ErrorReply {
  uint8_t code;
  uint8_t packetType;
};
#pragma pack(pop)

static_assert(sizeof(PacketHeader) == 16, "header must be 16 bytes");
