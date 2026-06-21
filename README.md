# 🧹 Chore Quest

A cozy, gamified chore tracker for two people. Track chores week over week, see who did what, set a weekly points goal, and earn levels, streaks, and badges together.

**Live app:** _(GitHub Pages URL — see Deploy below)_

It works **fully offline / local-first** the moment you open it. Cloud sync between two phones is **optional** (free Firebase) and set up entirely from inside the app's **Settings → Cloud sync**.

---

## Features

- **Weekly cooperative goal** — one shared points target is the hero; both of you win together.
- **Friendly split, not a scoreboard fight** — a head-to-head bar shows the labor split without a "loser."
- **Customizable weights** — each chore is worth 1–5 points (Quick → Dreaded). Points are *snapshotted* when logged, so changing a weight never rewrites past weeks.
- **Add / remove / assign chores** — assign to either person or "anyone."
- **One-tap logging with who-did-it** — each chore row has both partners' avatars; one tap logs *and* attributes.
- **Gamification** — shared household level/XP, a weekly goal streak (with a grace week), and 14 badges.
- **Stats** — week-over-week stacked chart, split-of-labor donut, and a by-chore table.
- **Delight** — confetti when you hit the goal, floating points, optional sound, haptics. Respects reduced-motion.
- **Robust** — survives private-mode storage, corrupt data, timezone/DST week boundaries, and undo.

## Tech

Plain HTML/CSS + ES modules. **No build step**, no framework. Files:

| File | Purpose |
|---|---|
| `index.html` | App shell |
| `styles.css` | Theme + layout (light/dark) |
| `lib.js` | Pure model: week math, scoring, levels, streaks, badges |
| `store.js` | Local-first persistence + in-memory fallback |
| `sync.js` | Optional Firebase Firestore sync (lazy-loaded) |
| `app.js` | Rendering + interaction |

---

## Deploy to GitHub Pages

Already done for this repo, but to redeploy / reproduce:

```bash
git add -A && git commit -m "update"
git push
```

Then in the repo: **Settings → Pages → Build and deployment → Source: Deploy from a branch → `main` / root**.

Because it's a static site with relative paths, it works directly from the Pages subpath. No server needed.

---

## Optional: turn on cloud sync (share between two phones)

The app is fully usable without this. To sync:

1. Go to **console.firebase.google.com → Add project** (you can skip Google Analytics).
2. **Build → Firestore Database → Create database →** *Production mode* → choose a region.
3. **Build → Authentication → Get started → Sign-in method →** enable **Anonymous**.
4. **Project settings (gear) → General → Your apps → Web app `</>`** → register → copy the **`firebaseConfig`** object.
5. **Firestore → Rules** → paste the rules below → **Publish**.
6. In the app: **Settings → Cloud sync → Set up cloud sync** → paste the config, pick a household code, **Connect**.
7. On the second phone: open the **invite link** from Settings (or paste the same config + code).

> The `apiKey` in `firebaseConfig` is a **public identifier, not a secret** — it's safe to paste into a client app. Security comes from the rules + Anonymous auth + your unguessable household code.

### Firestore security rules

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /households/{code} {
      // Any signed-in user who knows the (unguessable) household code can read/write it.
      allow read, write: if request.auth != null;
    }
  }
}
```

**Want it locked to just your two devices?** Use this stricter variant instead — the first two devices to use a code claim it, after which no one else can join:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /households/{code} {
      allow create: if request.auth != null;
      allow read, update: if request.auth != null
        && (resource.data.members == null
            || request.auth.uid in resource.data.members
            || resource.data.members.size() < 2);
      allow delete: if false;
    }
  }
}
```

(The default rules are recommended for simplicity; the household code is generated long and random.)

---

## Data & privacy

- Local data lives in your browser's `localStorage` (key `choretracker:v1`). Device-only prefs (theme, sound, sync config) live under `choretracker:device` and are never synced.
- **Export / Import** a JSON backup anytime from **Settings → Your data**.
- With sync on, all state lives in a single Firestore document at `households/{yourCode}` in **your own** Firebase project.
