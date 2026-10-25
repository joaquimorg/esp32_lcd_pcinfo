#pragma once

/*
 * Camada de ecrã: o main.cpp fala com um objeto "Lcd" que, conforme o ambiente
 * do platformio.ini, é o TFT_eSPI (LCDs SPI: ST7789, ILI9341…) ou a biblioteca
 * "GFX Library for Arduino" (LCD_BACKEND_GFX=1: AMOLED CO5300 por QSPI).
 *
 * Os pixels chegam do PC em RGB565 big-endian e vão tal e qual para o LCD
 * (pushPixels). As funções de desenho (texto, círculos) só servem o ecrã de
 * espera; lcdFillRect() é o PKT_FILL do PC.
 */

#if LCD_BACKEND_GFX

#include <Arduino_GFX_Library.h>

#ifndef MC_DATUM
#define MC_DATUM 4
#endif

// Os AMOLED só aceitam janelas com início par e largura/altura pares. A app
// alinha os retângulos (HELLO.align); o ecrã de espera desenha-se num canvas
// em memória e é enviado inteiro (ver present()).
#define LCD_ALIGN 2

#define TFT_BLACK 0x0000
#define TFT_WHITE 0xFFFF
#define TFT_RED   0xF800

class Lcd {
public:
  void init()
  {
    bus = new Arduino_ESP32QSPI(LCD_CS, LCD_SCLK, LCD_SDIO0, LCD_SDIO1, LCD_SDIO2, LCD_SDIO3);
    // Biblioteca 1.6.0 (a última sem esp32-hal-periman.h, do core 3.x): o construtor tem "ips".
    gfx = new Arduino_CO5300(bus, LCD_RST, 0 /* rotação */, false /* ips */, LCD_WIDTH, LCD_HEIGHT,
                             LCD_COL_OFFSET, 0, 0, 0);
    if (!gfx->begin()) return;
    gfx->setBrightness(255);
    gfx->fillScreen(0);
    // Framebuffer na PSRAM (big-endian, como chega): os frames só vão para o painel
    // inteiros, no fim (commit), em vez de aparecerem aos bocados. Sem PSRAM, escreve direto.
    const size_t bytes = (size_t)gfx->width() * gfx->height() * 2;
    fb = (uint16_t*)heap_caps_malloc(bytes, MALLOC_CAP_SPIRAM);
    stage = (uint8_t*)heap_caps_aligned_alloc(16, STAGE_BYTES, MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL);
    if (fb && stage) {
      memset(fb, 0, bytes);
      clearDirty();
    } else {
      if (fb) heap_caps_free(fb);
      if (stage) heap_caps_free(stage);
      fb = nullptr;
      stage = nullptr;
    }
    // Sem PSRAM não há canvas: o ecrã de espera fica em branco, o resto funciona.
    canvas = new Arduino_Canvas(gfx->width(), gfx->height(), gfx);
    if (!canvas->begin(GFX_SKIP_OUTPUT_BEGIN)) {
      delete canvas;
      canvas = nullptr;
    }
  }

  bool buffered() const { return fb != nullptr; }

  int16_t width() { return gfx ? gfx->width() : LCD_WIDTH; }
  int16_t height() { return gfx ? gfx->height() : LCD_HEIGHT; }
  void setRotation(uint8_t) {}
  void setSwapBytes(bool) {}

  /* ---- pixels do PC ---- */
  void startWrite() { if (!fb) gfx->startWrite(); }
  void endWrite() { if (!fb) gfx->endWrite(); }
  void setAddrWindow(int32_t x, int32_t y, int32_t w, int32_t h)
  {
    if (!fb) {
      gfx->writeAddrWindow(x, y, w, h);
      return;
    }
    wx = x; wy = y; ww = w; wh = h;
    cx = cy = 0;
    markDirty(x, y, w, h);
  }
  // Bytes já em big-endian, que é o que o CO5300 espera: vão sem trocar.
  void pushPixels(const uint16_t* data, uint32_t n)
  {
    if (!fb) {
      bus->writeBytes((uint8_t*)data, n * 2);
      return;
    }
    const uint8_t* src = (const uint8_t*)data;
    const int32_t stride = gfx->width();
    while (n && cy < wh) {
      uint32_t k = min<uint32_t>(n, ww - cx);
      memcpy(fb + (size_t)(wy + cy) * stride + wx + cx, src, k * 2);
      src += k * 2;
      n -= k;
      cx += k;
      if (cx >= ww) { cx = 0; cy++; }
    }
    lastWriteMs = millis();
  }
  void fillRectHw(int32_t x, int32_t y, int32_t w, int32_t h, uint16_t color)
  {
    if (!fb) {
      gfx->fillRect(x, y, w, h, color);
      return;
    }
    const uint16_t v = __builtin_bswap16(color);   // o framebuffer guarda big-endian
    const int32_t stride = gfx->width();
    for (int32_t yy = y; yy < y + h; yy++) {
      uint16_t* row = fb + (size_t)yy * stride + x;
      for (int32_t xx = 0; xx < w; xx++) row[xx] = v;
    }
    markDirty(x, y, w, h);
    lastWriteMs = millis();
  }

  // Como pushPixels, mas os pixels vêm a metade da largura e da altura: cada um vira
  // um bloco 2x2 na janela atual (hw x hh pixels de origem).
  bool pushPixels2x(const uint16_t* data, uint32_t hw, uint32_t hh)
  {
    if (!fb || (uint32_t)ww != hw * 2 || (uint32_t)wh != hh * 2) return false;
    const int32_t stride = gfx->width();
    for (uint32_t j = 0; j < hh; j++) {
      uint16_t* row = fb + (size_t)(wy + 2 * j) * stride + wx;
      const uint16_t* src = data + j * hw;
      for (uint32_t i = 0; i < hw; i++) row[2 * i] = row[2 * i + 1] = src[i];
      memcpy(row + stride, row, hw * 4);
    }
    lastWriteMs = millis();
    return true;
  }

  // Envia o retângulo alterado do framebuffer para o painel, de uma vez e já alinhado
  // a pares. Passa por um buffer interno (DMA): a PSRAM não serve para o SPI.
  void commit()
  {
    if (!fb || dx1 < dx0) return;
    const int32_t W = gfx->width(), H = gfx->height();
    const int32_t x0 = dx0 & ~1, y0 = dy0 & ~1;
    const int32_t x1 = min<int32_t>(dx1 | 1, W - 1), y1 = min<int32_t>(dy1 | 1, H - 1);
    const int32_t w = x1 - x0 + 1, h = y1 - y0 + 1;
    gfx->startWrite();
    gfx->writeAddrWindow(x0, y0, w, h);
    size_t used = 0;
    for (int32_t y = y0; y <= y1; y++) {
      const uint8_t* row = (const uint8_t*)(fb + (size_t)y * W + x0);
      size_t off = 0, rowBytes = (size_t)w * 2;
      while (off < rowBytes) {
        size_t k = min(rowBytes - off, STAGE_BYTES - used);
        memcpy(stage + used, row + off, k);
        used += k;
        off += k;
        if (used == STAGE_BYTES) {
          bus->writeBytes(stage, used);
          used = 0;
        }
      }
    }
    if (used) bus->writeBytes(stage, used);
    gfx->endWrite();
    clearDirty();
  }
  // Frame que ficou a meio (a app parou): mostra-o passado um tempo.
  void flushStale(uint32_t now)
  {
    if (fb && dx1 >= dx0 && now - lastWriteMs > STALE_MS) commit();
  }

  /* ---- ecrã de espera (canvas) ---- */
  uint16_t color565(uint8_t r, uint8_t g, uint8_t b) { return gfx->color565(r, g, b); }
  void setTextDatum(uint8_t) {}
  void setTextColor(uint16_t fg, uint16_t bg) { fg_ = fg; bg_ = bg; }
  void fillScreen(uint16_t c) { if (canvas) canvas->fillScreen(c); }
  void fillRect(int32_t x, int32_t y, int32_t w, int32_t h, uint16_t c) { if (canvas) canvas->fillRect(x, y, w, h, c); }
  void fillCircle(int32_t x, int32_t y, int32_t r, uint16_t c) { if (canvas) canvas->fillCircle(x, y, r, c); }
  // Texto centrado em (x, y). font 4 = grande, outros = pequeno.
  int16_t drawString(const String& s, int32_t x, int32_t y, uint8_t font = 2)
  {
    if (!canvas) return 0;
    canvas->setTextSize(font >= 4 ? 3 : 2);
    canvas->setTextColor(fg_, bg_);
    int16_t x1, y1;
    uint16_t w, h;
    canvas->getTextBounds(s, 0, 0, &x1, &y1, &w, &h);
    canvas->setCursor(x - (int32_t)w / 2 - x1, y - (int32_t)h / 2 - y1);
    canvas->print(s);
    return w;
  }
  // Envia o canvas inteiro (0,0 e tamanho pares).
  void present() { if (canvas) canvas->flush(); }

  // Ecrã desligado (sem pixels acesos): o AMOLED não gasta nem se desgasta.
  void sleep() { gfx->displayOff(); }
  void wake()
  {
    gfx->displayOn();
    gfx->setBrightness(255);
  }

private:
  static constexpr size_t STAGE_BYTES = 4096;
  static constexpr uint32_t STALE_MS = 250;
  uint16_t* fb = nullptr;      // framebuffer em PSRAM (RGB565 big-endian), ou nullptr
  uint8_t* stage = nullptr;    // buffer interno para o envio ao painel
  int32_t wx = 0, wy = 0, ww = 0, wh = 0, cx = 0, cy = 0;   // janela de escrita atual
  int32_t dx0 = 0, dy0 = 0, dx1 = -1, dy1 = -1;              // retângulo alterado (inclusive)
  uint32_t lastWriteMs = 0;

  void clearDirty() { dx0 = dy0 = 0x7FFFFFFF; dx1 = dy1 = -1; }
  void markDirty(int32_t x, int32_t y, int32_t w, int32_t h)
  {
    dx0 = min(dx0, x); dy0 = min(dy0, y);
    dx1 = max(dx1, x + w - 1); dy1 = max(dy1, y + h - 1);
  }

  Arduino_DataBus* bus = nullptr;
  Arduino_CO5300* gfx = nullptr;
  Arduino_Canvas* canvas = nullptr;
  uint16_t fg_ = 0xFFFF, bg_ = 0;
};

static inline void lcdFillRect(Lcd& l, int32_t x, int32_t y, int32_t w, int32_t h, uint16_t c) { l.fillRectHw(x, y, w, h, c); }
static inline void lcdPresent(Lcd& l) { l.present(); }
static inline void lcdCommit(Lcd& l) { l.commit(); }
static inline bool lcdPushPixels2x(Lcd& l, const uint16_t* d, uint32_t hw, uint32_t hh) { return l.pushPixels2x(d, hw, hh); }
static inline void lcdFlushStale(Lcd& l, uint32_t now) { l.flushStale(now); }
static inline bool lcdBuffered(Lcd& l) { return l.buffered(); }
static inline bool lcdCanRotate(Lcd&) { return false; }
static inline bool lcdCanUpscale(Lcd& l) { return l.buffered(); }
static inline void lcdSleep(Lcd& l) { l.sleep(); }
static inline void lcdWake(Lcd& l) { l.wake(); }

#else  // TFT_eSPI

#include <TFT_eSPI.h>

#define LCD_ALIGN 1

typedef TFT_eSPI Lcd;

static inline void lcdFillRect(Lcd& l, int32_t x, int32_t y, int32_t w, int32_t h, uint16_t c) { l.fillRect(x, y, w, h, c); }
static inline void lcdPresent(Lcd&) {}
static inline void lcdCommit(Lcd&) {}
// Sem framebuffer: cada linha de origem é duplicada em largura e enviada duas vezes
// para a janela já aberta (hw x hh pixels de origem, janela de 2*hw x 2*hh).
static inline bool lcdPushPixels2x(Lcd& l, const uint16_t* data, uint32_t hw, uint32_t hh)
{
  static uint16_t row[TFT_HEIGHT];   // 2*hw <= largura da janela <= TFT_HEIGHT
  if (2 * hw > TFT_HEIGHT) return false;
  for (uint32_t j = 0; j < hh; j++) {
    const uint16_t* src = data + j * hw;
    for (uint32_t i = 0; i < hw; i++) row[2 * i] = row[2 * i + 1] = src[i];
    l.pushPixels(row, 2 * hw);
    l.pushPixels(row, 2 * hw);
  }
  return true;
}
static inline void lcdFlushStale(Lcd&, uint32_t) {}
static inline bool lcdBuffered(Lcd&) { return false; }
static inline bool lcdCanUpscale(Lcd&) { return true; }
static inline bool lcdCanRotate(Lcd&) { return true; }

// LCDs com backlight (ex: CYD, TFT_BL): apaga-o. Sem TFT_BL não há nada a desligar.
#ifndef TFT_BACKLIGHT_ON
#define TFT_BACKLIGHT_ON HIGH
#endif
static inline void lcdSleep(Lcd&)
{
#ifdef TFT_BL
  digitalWrite(TFT_BL, !TFT_BACKLIGHT_ON);
#endif
}
static inline void lcdWake(Lcd&)
{
#ifdef TFT_BL
  digitalWrite(TFT_BL, TFT_BACKLIGHT_ON);
#endif
}

#endif
