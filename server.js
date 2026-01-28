// Load environment variables from .env file (only in development)
// In production (Render), env vars are already set
if (process.env.NODE_ENV !== 'production') {
  await import('dotenv/config');
}

// Start the React Router server
await import('./build/server/index.js');
