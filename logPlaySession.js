// Copy this file into your React project, e.g. src/lib/logPlaySession.js
//
// Reads the server URL from Vite's env system:
//   .env.local        VITE_API_BASE_URL=http://localhost:4000
//   .env (deployed)   VITE_API_BASE_URL=https://your-server.onrender.com
const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:4000';

export async function logPlaySession({ game, playerName = 'Guest', stars, totalRounds, peakStreak = 0 }) {
  try {
    await fetch(`${API_BASE}/api/plays`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ game, playerName, stars, totalRounds, peakStreak }),
    });
  } catch (err) {
    // A logging failure should never break the game itself.
    console.warn('Could not log play session', err);
  }
}
