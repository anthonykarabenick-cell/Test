# Lightline

Design Christmas lights on a photo of your own house, and see them at night before you buy a single strand.

## What it does

- **Upload a photo** of the front of your house (or drag it in, or paste it).
- **Night mode** turns the daytime photo into a night scene: darker exposure, less color, a blue shift and a darker sky.
- **Draw lights** by tapping along the roofline, gutters, railings or windows:
  - **String:** C9, C7 or mini bulbs along any line
  - **Icicle:** drops of varying length hanging from the eave
  - **Net:** a grid of mini lights over a bush or hedge
- **Lights spill onto the house.** Siding, trim and gutters near a strand glow in the color of the bulbs. Dark shingles stay dark.
- **Eight color sets** (warm white, cool white, classic multi, red & green, candy cane, blue, gold, purple) and four effects (steady, twinkle, chase, fade).
- **Real-world scale:** draw a line over your front door and type its height. Bulb sizes and spacing are then true to life.
- **Shopping list:** feet of lights and bulb counts for each type, with 10% added for slack and runs to the outlet.
- **Before / after** slider and **Save image** to download the result as a PNG.

Everything runs in the browser. Photos are never uploaded to a server.

## Run it

It's a static site with no build step and no dependencies.

```sh
# any static file server works
python3 -m http.server 8000
# then open http://localhost:8000
```

To put it online, enable **GitHub Pages** for this repository (Settings → Pages → deploy from the `main` branch, root folder).

## Tips for a good photo

- Stand across the street and face the house straight on.
- Get the whole roofline in the frame.
- Shoot in daylight or at dusk. A night photo is already dark, so the night grade has nothing to work with.

## Controls

| Key | Action |
| --- | --- |
| `D` | Add lights |
| `V` | Select & move |
| `S` | Set scale |
| `Enter` / double-click | Finish the strand |
| `Shift` while drawing | Keep the line horizontal, vertical or 45° |
| `Esc` | Cancel the strand / deselect |
| `Delete` | Remove the last point, or the selected strand |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / redo |

In **Select & move**, drag a dot to reshape a strand, drag the line to move it, double-click a line to add a point, and double-click a dot to remove it.

## How the rendering works

`app.js` renders in three passes at the photo's own resolution:

1. **Night grade:** each pixel is converted to linear light. The image is exposed down about 3.7 stops, desaturated and shifted toward blue, with the top of the frame falling off faster to darken the sky.
2. **Light spill:** each bulb adds a soft pool of its color on a quarter-resolution buffer. That buffer is multiplied by the daytime photo, which acts as the surface color, and added to the scene. Light siding reflects a lot and dark roofing reflects little, as in real life.
3. **Bulbs:** each bulb gets an additive halo and a hot white core, sized from the bulb's real diameter.
