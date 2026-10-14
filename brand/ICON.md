# Preloved Market icon

The mark is a **price tag turned 45°, with a circular reuse arrow knocked out of
it and a string hole near the tip** — secondhand goods changing hands again.

## Colours

- Cream `#FFFEEA` (tile / background)
- Black `#000000` (the mark)

Only these two colours are used; the dark featured version swaps them
(cream mark on black).

## Files

- `icon.svg` / `icon.png` — app icon, 1024×1024, set as `icon.image` in `dapp.json`
  (the ♻️ emoji stays as fallback).
- `featured-light.svg` / `featured-light.png` — featured artwork, 1600×900,
  black mark on cream (for light contexts).
- `featured-dark.svg` / `featured-dark.png` — featured artwork, 1600×900,
  cream mark on black (for dark contexts).

## Redrawing

Edit the SVG (one flat `<g>` per file, no gradients or filters), then rasterize:

```sh
rsvg-convert -w 1024 -h 1024 brand/icon.svg -o brand/icon.png
rsvg-convert -w 1600 -h 900 brand/featured-light.svg -o brand/featured-light.png
rsvg-convert -w 1600 -h 900 brand/featured-dark.svg -o brand/featured-dark.png
```

Keep `icon.png` under 256 KB — the platform falls back to the emoji above that.
