const API_BASE = typeof window !== 'undefined' && window.location.hostname !== 'localhost'
  ? ''  // Same origin on Vercel
  : 'http://localhost:3001';

export default API_BASE;
