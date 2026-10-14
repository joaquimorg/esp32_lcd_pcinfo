# Changelog

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
