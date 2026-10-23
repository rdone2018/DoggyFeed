# DoggyFeed

A lightweight meal-planning app for tracking food nutrition across multiple dogs, served by Node.js and backed by MariaDB.

## Requirements

Node.js 18 or later and a MariaDB server. Create the `doggyfeed` database and grant the `doggyfeed` user access to it before starting the app.

## Run

```sh
npm install
npm start
```

Place the database settings in `/etc/doggyfeed/doggyfeed.env` before starting the app. Use `.env.example` as the template and restrict access to the file (for example, `chmod 600 /etc/doggyfeed/doggyfeed.env`). The app reads this path before creating its MariaDB connection pool. To use a different env file for local development, set `DOGGYFEED_ENV_FILE`. Open `http://127.0.0.1:3000`. For automatic restarts during development, run `npm run dev`.

The app stores dog profiles, foods and pictures, meal contents, saved plans, and the selected dog in MariaDB tables. If an existing `data/state.json` file is present and the database has not yet been initialized, its contents are imported once. The database env file and `data/` directory are ignored by Git. Database settings can also be provided through environment variables: `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, and `DB_PASSWORD`.

## Features

- Keep individual dog profiles, weights, life stages, and activity estimates.
- Maintain a food library with energy, protein, fat, and fiber values per 100 g.
- Add foods and serving amounts to each dog's bowl to calculate nutrition totals.
- Save named meal plans and load them into any dog's bowl for reuse.
- Save profiles, foods, and meal plans to MariaDB through the Node server.

The starter foods are sample entries. Verify nutrition values against product labels or a trusted database. The energy reference is a rough estimate, not a feeding prescription or veterinary advice. The server binds to `127.0.0.1` by default; set `HOST` or `PORT` to override it.
