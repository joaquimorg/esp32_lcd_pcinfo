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
    // Sem PSRAM não há canvas: o ecrã de espera fica em branco, o resto funciona.
    canvas = new Arduino_Canvas(gfx->width(), gfx->height(), gfx);
    if (!canvas->begin(GFX_SKIP_OUTPUT_BEGIN)) {
      delete canvas;
      canvas = nullptr;
    }
  }

  int16_t width() { return gfx ? gfx->width() : LCD_WIDTH; }
  int16_t height() { return gfx ? gfx->height() : LCD_HEIGHT; }
  void setRotation(uint8_t) {}
  void setSwapBytes(bool) {}

  /* ---- pixels do PC ---- */
  void startWrite() { gfx->startWrite(); }
  void endWrite() { gfx->endWrite(); }
  void setAddrWindow(int32_t x, int32_t y, int32_t w, int32_t h) { gfx->writeAddrWindow(x, y, w, h); }
  // Bytes já em big-endian, que é o que o CO5300 espera: vão sem trocar.
  void pushPixels(const uint16_t* data, uint32_t n) { bus->writeBytes((uint8_t*)data, n * 2); }
  void fillRectHw(int32_t x, int32_t y, int32_t w, int32_t h, uint16_t color) { gfx->fillRect(x, y, w, h, color); }

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
  Arduino_DataBus* bus = nullptr;
  Arduino_CO5300* gfx = nullptr;
  Arduino_Canvas* canvas = nullptr;
  uint16_t fg_ = 0xFFFF, bg_ = 0;
};

static inline void lcdFillRect(Lcd& l, int32_t x, int32_t y, int32_t w, int32_t h, uint16_t c) { l.fillRectHw(x, y, w, h, c); }
static inline void lcdPresent(Lcd& l) { l.present(); }
static inline void lcdSleep(Lcd& l) { l.sleep(); }
static inline void lcdWake(Lcd& l) { l.wake(); }

#else  // TFT_eSPI

#include <TFT_eSPI.h>

#define LCD_ALIGN 1

typedef TFT_eSPI Lcd;

static inline void lcdFillRect(Lcd& l, int32_t x, int32_t y, int32_t w, int32_t h, uint16_t c) { l.fillRect(x, y, w, h, c); }
static inline void lcdPresent(Lcd&) {}

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
