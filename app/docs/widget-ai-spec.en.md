# Component specification for the USB LCD

You are going to create a **component** for a small LCD connected to a PC over
USB. A component is an HTML page that shows data from the PC's sensors
(temperatures, loads, power, clock, etc.). In the app, the user puts
components together on a screen (which the app calls a "widget"), positions
them and configures them. The app draws everything and sends the pixels to the
LCD. If the request is for a whole screen, make one component that fills the
whole screen (the size is in section 7).

In this document, "widget" and "component" mean the same thing: the file you
are going to write.

Answer **only with a complete HTML file**, inside a single ```html block. Do
not add explanations before or after it, because the user will paste the
answer straight into the app.

## 1. File format

The file must have:

1. A JSON manifest embedded in
   `<script type="application/json" id="widget-manifest">…</script>`.
2. The SDK, loaded exactly with
   `<script src="../_sdk/widget-sdk.js"></script>`.
3. Your code, which registers `Widget.onUpdate(...)`.

### Manifest

```json
{
  "name": "Short widget name",
  "description": "One sentence about what it shows.",
  "size": { "w": 200, "h": 120 },
  "properties": [
    { "key": "sensor", "type": "sensor", "label": "Sensor" },
    { "key": "label",  "type": "text",   "label": "Caption", "default": "CPU" },
    { "key": "max",    "type": "number", "label": "Maximum", "default": 100, "min": 0, "max": 1000 },
    { "key": "color",  "type": "color",  "label": "Colour", "default": "#00c8ff" },
    { "key": "glow",   "type": "boolean","label": "Glow", "default": true },
    { "key": "style",  "type": "select", "label": "Style", "default": "bars", "options": ["bars", "line"] },
    { "key": "icon",   "type": "file",   "label": "Image" }
  ]
}
```

- `size` is the initial size in pixels. The user can resize the widget, so the
  drawing must adapt to any size.
- `category` (optional) is the group in the app's palette: `"component"`
  (default, for widgets with data), `"shape"` (decoration) or `"image"`.
- `properties` defines the form the user sees in the app. Each entry has
  `key`, `type` and `label`, and optionally `default`.
- Property types:

| type | Value the widget receives | Notes |
|---|---|---|
| `sensor` | sensor object (see section 3) or `null` | the user picks the sensor in the app |
| `text` | string | |
| `number` | number | accepts `min` and `max` |
| `color` | string `"#rrggbb"` | always use 6 hex digits |
| `boolean` | `true` / `false` | |
| `select` | one of the strings in `options` | `options` is required |
| `file` | `file:///…` URL of an image, or empty | |

- For every piece of data the widget shows, create a `sensor` property. Never
  write sensor IDs in the code, because the user picks them.
- Expose colours, captions and limits (minimum and maximum) as properties,
  always with sensible default values.

## 2. Runtime environment

- It runs in Chromium (Electron), from `file://`, **without internet**. Do not
  use CDNs, web fonts, remote images or `fetch`. Put all CSS and JS inside the
  file. Inline SVG and `<canvas>` work well.
- Available fonts: the Windows ones (`"Segoe UI"`, `"Segoe UI Variable"`,
  `Consolas`, `"Cascadia Mono"`, `Bahnschrift`, `system-ui`). For numbers use
  `font-variant-numeric: tabular-nums`, so the digits do not jump around.
- The widget runs in an iframe the size of the widget, with a **transparent
  background**:
  - `html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: transparent; }`
  - The page background is set by the user (usually black). If you want a card
    with a background, draw it inside the widget and make its colour
    configurable.
- Do not access `window.parent`, `localStorage` or system APIs.

## 3. Data: the SDK

```js
Widget.onUpdate((props, info) => {
  // props: values of the manifest properties (with defaults applied)
  // info.size: { width, height } — current size of the widget in pixels
  // info.sensorSeq: number that changes with every new sensor reading
  // info.lang: language of the app ('en' or 'pt'); Widget.locale(info) gives 'en-GB' or 'pt-PT'
});
```

- The callback is called when the widget loads, on every sensor reading
  (usually once per second) and whenever the user changes a property or the
  size. **Draw everything from `props` and `info.size` every time**, without
  keeping state between calls.
- A `sensor` property arrives as:

```js
{
  id: "/amdcpu/0/temperature/2",
  name: "Core (Tctl/Tdie)",      // sensor name
  hardware: "AMD Ryzen 5 3600",  // device
  group: "Temperatures",
  type: "Temperature",           // Temperature, Load, Power, Clock, Fan, Data, Voltage, ...
  value: 57.5,                   // number, or null if there is no reading
  unit: "°C",
  min: 41.0, max: 78.3,          // minimum/maximum since start-up, may be null
  history: [55.1, 56.0, 57.5]    // latest readings (up to 600), the most recent last
}
```

  or `null` if the user has not picked a sensor yet or it does not exist.
  Always handle `null` and `value === null` by showing `--`.
- For history graphs use `sensor.history` instead of storing values yourself.
- Helper functions:
  - `Widget.format(sensor, decimals)`: returns the value with `decimals`
    decimal places, or `"--"`.
  - `Widget.fraction(value, min, max)`: returns the position of the value
    between min and max, limited to 0..1.
  - `Widget.mix(colorA, colorB, t)`: interpolates two `#rrggbb` colours by hue
    (from blue to red it goes through green and yellow).

## 4. The screen and performance (important)

- The LCD has few colours (RGB565, 65 thousand) and a density of 1 px = 1
  physical pixel. So:
  - Use high contrast on a dark background and text of at least **11 px**.
  - Prefer solid colours. Soft gradients and subtle shadows show banding.
  - Avoid very faint 1 px lines, because they disappear.
- Every pixel that changes is sent over USB (about 0.5 MB/s in total). Pixels
  that do not change cost nothing. So:
  - Animate only when the data changes. Short CSS transitions (≤ 0.8 s) are
    fine.
  - **Do not make continuous animations**: no `animation: … infinite`,
    `requestAnimationFrame` loops, blinking or permanent particles. If a
    continuous animation is really requested, limit it to a small area.
  - For clocks, use a `setInterval` of 1 s or more and only change the DOM
    when the text changes.
- Scale font sizes and elements to `info.size`, so the widget looks good both
  small (e.g. 100×50) and large (e.g. 240×200).

## 5. Complete example

```html
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<script type="application/json" id="widget-manifest">
{
  "name": "Load ring",
  "description": "Ring with the percentage of a sensor and its name underneath.",
  "size": { "w": 120, "h": 120 },
  "properties": [
    { "key": "sensor", "type": "sensor", "label": "Sensor" },
    { "key": "label", "type": "text", "label": "Caption", "default": "" },
    { "key": "min", "type": "number", "label": "Minimum", "default": 0 },
    { "key": "max", "type": "number", "label": "Maximum", "default": 100 },
    { "key": "color", "type": "color", "label": "Colour", "default": "#00c8ff" },
    { "key": "colorHigh", "type": "color", "label": "Colour (high)", "default": "#ff3b30" },
    { "key": "textColor", "type": "color", "label": "Text colour", "default": "#ffffff" }
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

## 6. Checklist before you answer

- [ ] A single HTML file in a ```html block, with no text around it.
- [ ] Has `<script type="application/json" id="widget-manifest">` with valid
      JSON (no comments or trailing commas).
- [ ] Has `<script src="../_sdk/widget-sdk.js"></script>` before your code.
- [ ] Uses no external resources.
- [ ] Transparent background; adapts to `info.size`.
- [ ] Handles `null` sensors and `null` values.
- [ ] Has no continuous animations.
- [ ] Colours, captions and limits are properties with a `default`.
