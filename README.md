# 4th & Cold Squares

A season-long football squares board for the Texas Longhorns tailgate. Static site (GitHub Pages) + Firebase backend. Free at this scale.

**What it does**

- Public 10×10 board, real-time — squares disappear the moment someone claims them
- Players claim with name + email once; their squares follow them all season
- Per-game tabs for all six home games, each with its own drawn numbers
- Admin: lock/unlock board, animated live number draw (crypto-random), payment tracking (amount received, paid-to, auto-settled), season config
- Live scores from ESPN on game day: score strip, pulsing "currently winning" square, one-tap winner recording per quarter
- Pot tracker: squares sold, payouts, remainder to the tailgate fund
- Season relaunch: change price/payouts/games, clear the board, go again next year

---

## Setup (one time, ~15 minutes)

### 1. Create the Firebase project
1. Go to [console.firebase.google.com](https://console.firebase.google.com) → **Add project** (e.g. `fourth-and-cold`). Google Analytics: off.
2. **Build → Firestore Database → Create database** → Start in **production mode** → location `nam5 (us-central)`.
3. **Build → Authentication → Get started** → enable **two** sign-in methods:
   - **Anonymous** (players)
   - **Google** (admins)
4. **Authentication → Settings → Authorized domains** → **Add domain** → `YOUR-USERNAME.github.io`

### 2. Paste the security rules
Firestore Database → **Rules** tab → replace everything with the contents of `firestore.rules` → **Publish**.

### 3. Connect this code to your project
1. Firebase console → ⚙️ **Project settings → Your apps → Web** (`</>`), register an app (no hosting needed).
2. Copy the `firebaseConfig` object it shows you into `firebase-config.js` in this repo.

### 4. Deploy on GitHub Pages
1. Create a new GitHub repo (e.g. `fourth-and-cold`), push these files to `main`.
2. Repo → **Settings → Pages** → Source: **Deploy from a branch** → `main` / root → Save.
3. Site goes live at `https://YOUR-USERNAME.github.io/fourth-and-cold/` in a minute or two.

### 5. First-run season setup
1. Open the site → tap **Admin** → sign in with your Google account.
2. The season settings form appears (any Google account can bootstrap the *first* config; after that, only listed admins can touch it — your email is auto-added so you can't lock yourself out).
3. Fill in: season name, price ($250), payout ($500), admin emails, Venmo lines (`dan-huskerson | all you Blanco and Leander people`), welcome blurb, and the six games. **Fetch Texas home schedule** pre-fills opponents/dates/ESPN IDs from ESPN — take the last 6 rows it gives you.
4. **Save season.** Done — share the link.

---

## Running a game week

1. **Before kickoff (within 24 hrs):** open the game's tab → Admin → **Draw numbers**. The digits slot-machine on screen — do it live at the tailgate.
2. **During the game:** the site polls ESPN every 60s. Score strip shows up top; the square that would win the current quarter pulses gold.
3. **After each quarter (or after the game):** Admin → **Pull scores & record winners**. It computes each completed quarter's winner from the linescores and writes them to the ledger. Re-running is safe — it just re-computes. Q4 pays on the end-of-regulation score (overtime is excluded).
4. **Payments:** Admin → Payments table aggregates everyone's square count automatically; type in what they Venmo'd and to whom. Settled turns green when received ≥ owed.

## New season next year
Admin → Season setup → update price/payout/games → **Clear all squares** → share the same link. Squares, payments, numbers, and winners reset; config stays.

---

## Notes & gotchas

- **Score data** comes from ESPN's public (unofficial) scoreboard API, fetched from the viewer's browser. If auto-find can't match a game by date, grab the game ID from the espn.com game URL and paste it in the admin panel.
- **Two admin tiers:** Power admins (everything, including assigning payment admins) and Payment admins (payments table plus square rename/release only). Both are set in Season setup; enforced server-side by Firestore rules.
- **Audit trail:** every claim, rename, release, lock, draw, winner, payment change, and season save is logged to an append-only audit collection (Admin → Audit log). Survives season resets.
- **Player identity is honor-system by email** (same as the old site), but each claim is bound to the device that made it — only that device (or an admin) can edit or release the square, and only while the board is unlocked. Admin actions require Google sign-in against the allowlist, enforced server-side by Firestore rules.
- **If someone claims from the wrong email / wants to move squares:** an admin can edit or release any square by tapping it.
- **Free tier limits** (50K reads/day) are far beyond what 100 squares and ~60 people generate, even on game day.
- **Payments are private** — only admins can read the payments collection.
