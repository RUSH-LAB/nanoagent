/** Base URL for API requests. Empty string (same-origin) in production, localhost:3001 in dev. */
const API_BASE = typeof window !== 'undefined' && window.location.hostname !== 'localhost'
  ? ''  // Same origin on Vercel
  : 'http://localhost:3001';

export default API_BASE;
