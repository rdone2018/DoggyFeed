# DoggyFeed

A lightweight meal-planning app for tracking food nutrition across multiple dogs, served by Node.js.

## Requirements

Node.js 18 or later. The application uses only Node built-in modules and has no package dependencies.

## Run

```sh
npm start
```

Open `http://127.0.0.1:3000`. For automatic restarts during development, run `npm run dev`.

Application data is stored in `data/state.json` and created on the first save. The `data/` directory is ignored by Git. If the server starts with no saved state, it imports existing DoggyFeed browser data when available; the server then becomes the primary store.

## Features

- Keep individual dog profiles, weights, life stages, and activity estimates.
- Maintain a food library with energy, protein, fat, and fiber values per 100 g.
- Add foods and serving amounts to each dog's bowl to calculate nutrition totals.
- Save named meal plans and load them into any dog's bowl for reuse.
- Save profiles, foods, and meal plans to the Node server's JSON datastore.

The starter foods are sample entries. Verify nutrition values against product labels or a trusted database. The energy reference is a rough estimate, not a feeding prescription or veterinary advice. The server binds to `127.0.0.1` by default; set `HOST` or `PORT` to override it.
