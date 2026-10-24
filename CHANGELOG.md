# Changelog

## Unreleased

**More boards and displays**
- New environment `waveshare_amoled_206` for the Waveshare ESP32-S3-Touch-AMOLED-2.06
  (410×502 AMOLED, CO5300 over QSPI, native USB), using the GFX Library for
  Arduino through a new display layer (`src/lcd.h`). Not tested on the real
  board yet.
- The HELLO reply has an `align` byte: with 2 the app widens every rectangle
  and the visible area to even x, y, width and height, as the CO5300 requires.

## 0.10.0

**New components**
- **Ring**: full-circle progress with the value in the centre (start angle,
  direction, rounded ends, colour that follows the value).
- **Level**: segmented or plain bar, horizontal or vertical: VU meter, tank,
  thermometer.
- **Trend card**: large value, trend arrow and a small history graph.
- **Sensor list**: up to 6 rows of caption and value, with optional separators.
- **Indicator**: lamp that turns green, amber or red from warning and critical
  limits (or the reverse, for a battery).
- **Sensor text**: free text with `{name}` `{value}` `{unit}` `{min}` `{max}`,
  font choices and a colour change above a limit.
- **Date**: calendar page or plain date.

## 0.9.0

**Editor**
- **Lock components**: a padlock in the component list (and a switch in the
  properties) stops a component from being moved or resized, by mouse, arrow
  keys or the X/Y/size fields. The Delete key is also ignored while locked. The
  lock is saved in the widget and in `.lcdwidget` files.
- **Text** component: choice of font (12 common Windows fonts), bold (700 added
  to the weights), italic and underline.
- **Clock** component: same font choices (font, weight, italic), 12/24-hour
  format, blinking colon, and four styles for the seconds: same as the time,
  small, dimmed colour or a progress bar, with its own colour.

## 0.8.0

**Faster refresh**
- Changed areas are found with 16×16 tiles instead of full-width 16-line
  bands, and trimmed to the exact changed pixels.
- New LZ4 rectangles (`PKT_RECT_LZ4`): about 2.4× smaller than RLE on real LCD
  frames. The firmware announces support in the HELLO flags; the app falls back
  to RLE/raw with older firmware, so **flash the new firmware** to get it.
- `LCD_DEBUG=1` now shows bytes per format, rectangles and wasted pixels.

**More boards and displays**
- Firmware builds per board in `platformio.ini`: `lolin_s2_mini` (unchanged),
  `cyd28_ili9341` and `cyd28_st7789` for the ESP32 CYD 2.8" (240×320).
- New UART transport for boards without native USB (CH340/CP210x), 921600 baud,
  selected with `LCD_TRANSPORT_UART=1`. The HELLO reply now says which
  transport the board uses.
- The app finds CH340/CH9102/CP210x ports automatically, keeps DTR/RTS low
  while opening them (so the board does not reset) and restarts a stuck board
  with an RTS pulse.
- The CYD touch screen is not used yet.

## 0.7.0

**Languages**
- The app is now in English (default) and Portuguese: Settings → General →
  Language. The change applies right away, without restarting.
- Translated: the app window, tray menu, dialogs, error messages, built-in
  components, clock date, calibration pattern, the AI instructions (new
  English specification) and the LCD's "waiting for data" screen.
- Component manifests can carry translations (`i18n.<lang>`); stored values
  never change with the language.

**Settings**
- New **Settings** tab with General, Sensors, ESP32 connection and LCD screen
  (visible area and calibration). The Run tab keeps only the widgets, what is
  on the LCD now and the transitions.
- About line with the version and copyright.

**Fixes**
- Transitions: the incoming widget was see-through, so the previous one showed
  behind it.
- The calibration pattern could stay black on the LCD: it was drawn while the
  LCD window was being resized and that drawing was lost. It is now redrawn.

**Firmware** (flash it again: `pio run -t upload`)
- Waiting screen in English or Portuguese, chosen by the app and stored in
  flash (`PKT_LANG`).

**Project**
- MIT License, © 2026 joaquim.org.
- README with screenshots and an animated demo of the LCD.

## 0.6.0

- **Shapes**: line, rectangle, circle/ellipse, arc and polygon/star.
- **Images**: PNG/JPG with transparency, animated GIF and WebP, SVG and BMP;
  opacity, rotation, rounded corners, pixel-art mode, still-frame option.
  Adding an image sizes the component to the image.
- **Transitions** between widgets: fade, slide, push, zoom, wipe, circle and
  random, with a general setting and a per-widget override. The previous
  widget stays on the LCD until the next one has loaded.
- Palette grouped into Components, Shapes and Images.
- **USB stability**: frames are sent in batches of up to 16 KB, one at a time,
  so the ESP32's receive buffer never fills up. Before, continuous traffic
  (e.g. animated GIFs) could stall the ESP32-S2's USB and make it restart in a
  loop.
- Firmware: reports why it last restarted and restarts itself if the USB link
  stops receiving with the port open for 10 s.

## 0.5.0

- Widget editor with snapping guides, components with AI, `.lcdwidget`
  import/export, visible-area calibration, tray, start with Windows.
