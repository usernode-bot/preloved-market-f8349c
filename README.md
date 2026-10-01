# Preloved Market

Buy, sell and give away preowned goods inside your community.

Browse a listing grid of what neighbours are offering, open an item to see
its condition, price and seller, and post your own items in seconds —
either at a price or as a free giveaway.

## Features

- **Listing grid** — photo placeholder, title, price (or Giveaway pill) and
  a colour-coded condition badge on every card; sold items are dimmed with
  a Sold overlay.
- **Search & filter** — free-text search over titles plus a condition
  filter (New / Like new / Good / Fair).
- **Item detail** — full listing with seller contact and, for the seller
  themselves, a toggle to mark the item as sold (or given away) and back to
  available.
- **Post an item** — validated form: title of at least 3 characters, a
  condition, and either a price or the "Give away for free" switch.

## Stack

Node.js / Express + PostgreSQL, Tailwind (precompiled per build), served
inside the Homeroom platform shell. The frontend is a single HTML file
with hash-routed views (`#/` grid, `#/item/:id` detail, `#/post` form).

## Data model

One `items` table: `title` (3–120 chars), `price_cents` (integer cents,
NULL for giveaways), `is_giveaway`, `condition` (`new` | `like-new` |
`good` | `fair`), `status` (`available` | `sold` | `given`), plus the
poster's `user_id`/`username`.

## Development

```sh
npm ci --include=dev
npm run build   # compiles styles/tailwind-input.css → public/tailwind.css
npm start       # needs DATABASE_URL; runs migrations + staging seeds on boot
```