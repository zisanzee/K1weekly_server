# K1 Weekly Wonders — Play-Logging Server Setup

This adds a tiny free backend that logs every completed game (which game,
who played, their score, and their best streak), so you can see who played
and how many times.

Stack: **Express** (server) + **MongoDB Atlas** (free database) +
**Render** (free hosting). Total cost: $0.

---

## Part 1 — Create a free MongoDB database (Atlas)

1. Go to <https://www.mongodb.com/cloud/atlas/register> and sign up (free).
2. Create a cluster: pick the **M0 Free** tier, any cloud provider/region
   close to you, name it something like `k1weekly`. Click **Create**.
3. **Database Access** (left sidebar) → **Add New Database User** →
   pick a username/password (write these down) → give it
   **Read and write to any database** → **Add User**.
4. **Network Access** (left sidebar) → **Add IP Address** →
   **Allow Access from Anywhere** (`0.0.0.0/0`) → **Confirm**.
   (This is the simple option for a small hobby project — anyone would
   still need your username/password to actually connect.)
5. **Database** (left sidebar) → **Connect** on your cluster → **Drivers** →
   choose Node.js → copy the connection string. It looks like:
   ```
   mongodb+srv://<username>:<password>@k1weekly.xxxxx.mongodb.net/?retryWrites=true&w=majority
   ```
   Replace `<username>`/`<password>` with what you made in step 3, and add
   a database name right after `.net/`, e.g. `.net/k1weekly?retryWrites...`.
   Save this full string — it's your `MONGODB_URI`.

---

## Part 2 — Run the server on your computer

The files for this are in this `server/` folder:
`server.js`, `models/PlaySession.js`, `package.json`, `.env.example`.

1. `cd server`
2. `npm install`
3. Copy `.env.example` to `.env` and fill it in:
   ```
   MONGODB_URI=<the connection string from Part 1>
   PORT=4000
   ALLOWED_ORIGIN=http://localhost:5173
   ```
   (`ALLOWED_ORIGIN` should match wherever your React app runs locally —
   5173 is Vite's default.)
4. `npm run dev` (or `npm start`). You should see `Server running on port 4000`.
5. Open <http://localhost:4000/api/health> in a browser. You should see
   `{"ok":true,"dbState":1}` — `dbState: 1` means it's connected to MongoDB.
6. Test logging a play from a terminal:
   ```bash
   curl -X POST http://localhost:4000/api/plays \
     -H "Content-Type: application/json" \
     -d '{"game":"game2","playerName":"Test","stars":10,"totalRounds":12,"peakStreak":4}'
   ```
7. Back in Atlas: **Database** → **Browse Collections** → you should see a
   `playsessions` collection with your test entry. (This built-in Atlas
   viewer is a free, no-code way to look at your data any time.)

---

## Part 3 — Host the server for free (Render)

1. Push this `server/` folder to a GitHub repo (its own repo, or a
   subfolder of your existing project repo — either works).
2. Sign up at <https://render.com> (free) → **New** → **Web Service** →
   connect your GitHub repo.
3. If the server lives in a subfolder, set **Root Directory** to `server`.
4. **Build Command:** `npm install` — **Start Command:** `npm start`.
5. **Instance Type:** Free.
6. Under **Environment**, add:
   - `MONGODB_URI` → your Atlas connection string from Part 1
   - `ALLOWED_ORIGIN` → your deployed frontend's URL (you can update this
     later once you know it, e.g. `https://your-game.vercel.app`)
   - Don't set `PORT` — Render provides it automatically.
7. Click **Create Web Service** and wait for the build to finish. Render
   gives you a URL like `https://k1weekly-server.onrender.com`.
8. Visit `https://k1weekly-server.onrender.com/api/health` to confirm it's live.

> **Heads up:** Render's free tier "sleeps" after ~15 minutes with no
> traffic. The first request after that can take 30–50 seconds while it
> wakes up — totally fine for a personal project, just not instant.

---

## Part 4 — Connect it to your React app

1. Copy `client-integration/logPlaySession.js` into your project, e.g.
   `src/lib/logPlaySession.js`.
2. In your Vite project, add the server URL as an env variable:
   - `.env.local` (for local dev): `VITE_API_BASE_URL=http://localhost:4000`
   - `.env` (for your deployed build): `VITE_API_BASE_URL=https://k1weekly-server.onrender.com`
3. Call `logPlaySession(...)` when a game finishes. For example, in
   `Game2.jsx`'s completion effect:
   ```js
   import { logPlaySession } from '../lib/logPlaySession';

   useEffect(() => {
     if (phase === 'complete' && !hasRecordedRef.current) {
       hasRecordedRef.current = true;
       setIsNewHighScore(stars > highScore);
       recordRun(stars, peakStreak); // existing local zustand stats
       logPlaySession({ game: 'game2', stars, totalRounds: TOTAL_ROUNDS, peakStreak });
     }
   }, [phase]);
   ```
4. Do the same in `Game1.jsx` and `Game3.jsx` with `game: 'game1'` /
   `game: 'game3'` in their own completion handlers.
5. Redeploy your frontend (Vercel/Netlify/wherever) with
   `VITE_API_BASE_URL` set in that platform's environment variables too.

---

## Part 5 — Viewing the stats

- Overall + per-game totals: visit
  `https://k1weekly-server.onrender.com/api/stats` in a browser. Returns:
  ```json
  {
    "totalPlays": 42,
    "uniquePlayers": 7,
    "perGame": [
      { "_id": "game1", "plays": 15, "avgStars": 8.2, "bestStreak": 6 },
      { "_id": "game2", "plays": 20, "avgStars": 9.1, "bestStreak": 5 },
      { "_id": "game3", "plays": 7,  "avgStars": 7.4, "bestStreak": 4 }
    ]
  }
  ```
- Per-game leaderboard (top 10 by score):
  `https://k1weekly-server.onrender.com/api/leaderboard/game2`
- For a visual dashboard with zero extra code: MongoDB Atlas has a free
  **Charts** feature that plugs directly into your existing cluster —
  point it at the `playsessions` collection and drag out a bar chart of
  plays per game, a line chart of plays over time, etc.

---

## Notes

- The `POST /api/plays` endpoint has no login — anyone with the URL could
  send fake data. That's an acceptable tradeoff for a small personal
  project. If it ever matters, add a shared-secret header check in
  `server.js` and send it from `logPlaySession.js`.
- `ALLOWED_ORIGIN` restricts which websites can call the API *from a
  browser*. It can still be called directly (e.g. via curl) — that's
  normal for any public API and not something CORS can prevent.
- Everything here stays inside the free tiers: Atlas M0 (512MB storage —
  plenty for scores) and Render's free web service plan.
