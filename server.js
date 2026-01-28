#!/usr/bin/env node

// Load environment variables from .env file (only in development)
// In production (Render), env vars are already set via dashboard
if (process.env.NODE_ENV !== 'production') {
  try {
    await import('dotenv/config');
    console.log('[Dev] Environment variables loaded from .env');
  } catch (err) {
    console.log('[Dev] dotenv not available, continuing without .env file');
  }
}

// Set NODE_ENV to production if not set
process.env.NODE_ENV = process.env.NODE_ENV ?? "production";

console.log(`[Server] Starting React Router server in ${process.env.NODE_ENV} mode...`);
console.log('[Server] Cloudinary configured:', !!process.env.CLOUDINARY_CLOUD_NAME);

// Import and run the React Router CLI
// The CLI will use process.argv to get the build path (build/server/index.js)
// which is passed from package.json start script
import('./node_modules/@react-router/serve/dist/cli.js').catch((err) => {
  console.error('[Server] Failed to start:', err);
  process.exit(1);
});
