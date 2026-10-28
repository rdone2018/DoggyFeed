# DoggyFeed

A lightweight meal-planning app for tracking food nutrition across multiple dogs, served by Node.js and backed by MariaDB.

## Requirements

Node.js 18 or later and a MariaDB server. Create the `doggyfeed` database and grant the `doggyfeed` user access to it before starting the app.

## Run

```sh
npm install
npm start
```

Place the database settings in `/etc/doggyfeed/doggyfeed.env` before starting the app. Use `.env.example` as the template and restrict access to the file (for example, `chmod 600 /etc/doggyfeed/doggyfeed.env`). The app reads this path before creating its MariaDB connection pool. If that file is missing, for example on Windows, the app falls back to a `.env` file in the project folder (ignored by Git). To use a different env file, set `DOGGYFEED_ENV_FILE`. Open `http://127.0.0.1:3000`. For automatic restarts during development, run `npm run dev`.

After updating DoggyFeed (for example with `git pull`), restart the server. The page is read fresh on every visit, but the server code and database changes only load when the server starts. Until then, saves may not reach the database, and the page shows a "Restart the DoggyFeed server" warning.

If DoggyFeed runs behind a reverse proxy such as nginx, allow request bodies of a few megabytes (for example `client_max_body_size 20m;`) so new dog photos and food pictures can be saved. Pictures already stored are not sent again with later saves.

Open `http://127.0.0.1:3000/diagnostics` to inspect database tables, row counts, columns, and stored values. This read-only page is restricted to requests from the local computer.

The app stores dog profiles, foods and pictures, meal contents, saved plans, and the selected dog in MariaDB tables. If an existing `data/state.json` file is present and the database has not yet been initialized, its contents are imported once. The database env file and `data/` directory are ignored by Git. Database settings can also be provided through environment variables: `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, and `DB_PASSWORD`.

## Features

- Keep individual dog profiles, weights, desired weights, meals per day, life stages, and activity estimates. The bowl energy reference uses the desired weight when set and is split across the meals per day.
- Keep a weight history: each saved change to a dog's weight or desired weight is stored with its date, and the Weight history view (linked below the dog form) charts the last 12 months.
- Import weight and daily energy history from a CSV file in the Weight history view. The file needs a header row with `date` and `weight`, and may add `desired_weight`, `daily_energy`, and `daily_energy_custom` (yes/no). Dates can be `YYYY-MM-DD` or `DD.MM.YYYY`; comma, semicolon, or tab separators and decimal commas are accepted. A row for a day that already has an entry replaces it. Use the CSV template button for an example.
- Import foods into the food library from a CSV file with the Import CSV button. The file needs a header row with `name` and `kcal`, and may add `category`, `protein`, `fat`, and `fiber` (all per 100 g). A row whose name matches a food in the library updates it and keeps its picture; unknown categories become Other. Use the CSV template button for an example.
- Maintain a food library with energy, protein, fat, and fiber values per 100 g.
- Add foods and serving amounts to each dog's bowl to calculate nutrition totals. A food in the "Dry food" category fills the energy the other foods leave below the bowl target, and its amount updates as the bowl changes; typing an amount for it, or using its Auto-fill button, turns this off.
- Save named meal plans and load them into any dog's bowl for reuse.
- Save profiles, foods, and meal plans to MariaDB through the Node server.

The starter foods are sample entries. Verify nutrition values against product labels or a trusted database. The energy reference is a rough estimate, not a feeding prescription or veterinary advice. The server binds to `127.0.0.1` by default; set `HOST` or `PORT` to override it.
