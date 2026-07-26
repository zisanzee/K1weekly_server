import { create } from 'zustand';

// Backend base URL — reuse whatever env var the rest of the app already
// uses for the API. Adjust this if your project names it differently.
const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:4000';

// Canonical list of homepage game keys — must match GAME_KEYS in the
// backend's server.js. Add a new game to both places when you ship one.
export const GAME_KEYS = ['1', '2', '3', '4', '5', '6', 'b1'];

function normalizeKey(gameNumber) {
  return String(gameNumber);
}

// Holds which games are currently unlocked for players, as reported by the
// server. Teachers bypass this entirely (see useIsGameUnlocked below) —
// this store only ever describes player-facing access.
export const useGameAccessStore = create((set, get) => ({
  unlocked: {}, // { "1": true, "2": true, "b1": false, ... }
  loaded: false,
  loading: false,
  error: null,

  // Fetch the current unlock map from the server. Safe to call from
  // multiple components — a call already in flight is skipped.
  fetchGameAccess: async () => {
    if (get().loading) return;
    set({ loading: true, error: null });
    try {
      const res = await fetch(`${API_BASE}/api/game-access`);
      if (!res.ok) throw new Error('Failed to load game access');
      const rows = await res.json(); // [{ gameKey, unlocked }, ...]
      const unlocked = {};
      rows.forEach((row) => {
        unlocked[row.gameKey] = row.unlocked;
      });
      set({ unlocked, loaded: true, loading: false });
    } catch (err) {
      console.error(err);
      set({ loading: false, error: err.message });
    }
  },

  // Optimistic local update — called right after a successful PUT so the
  // panel and homepage reflect the change instantly without a re-fetch.
  setUnlockedLocal: (gameKey, isUnlocked) => {
    set((state) => ({
      unlocked: { ...state.unlocked, [normalizeKey(gameKey)]: isUnlocked },
    }));
  },
}));

// Ask the server to lock/unlock one game. Requires a valid teacher code —
// the same code checked in teacherCodes.js, verified again server-side so
// a student can't just call this endpoint directly from dev tools.
export async function setGameUnlocked(gameKey, isUnlocked, teacherCode) {
  const key = normalizeKey(gameKey);
  const res = await fetch(`${API_BASE}/api/game-access/${encodeURIComponent(key)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ unlocked: isUnlocked, teacherCode }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || 'Could not update game access');
  }

  const data = await res.json();
  useGameAccessStore.getState().setUnlockedLocal(key, data.unlocked);
  return data;
}

// Hook version — use inside components so they re-render when access
// changes (either from this device unlocking something, or from a
// re-fetch). Teachers always see everything unlocked, same as before.
export function useIsGameUnlocked(gameNumber, isTeacher) {
  const unlocked = useGameAccessStore((s) => s.unlocked[normalizeKey(gameNumber)]);
  return Boolean(isTeacher) || Boolean(unlocked);
}

// Non-hook version for use outside render (e.g. inside a useEffect that
// decides what to prefetch). Reads the store's current snapshot directly.
export function isGameUnlockedNow(gameNumber, isTeacher) {
  const unlocked = useGameAccessStore.getState().unlocked[normalizeKey(gameNumber)];
  return Boolean(isTeacher) || Boolean(unlocked);
}
