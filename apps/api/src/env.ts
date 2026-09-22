/**
 * Loads apps/api/.env. Imported first by index.ts, so it runs before any
 * module reads process.env at load time (lib/claude.ts picks its provider then).
 *
 * `.env` wins over variables inherited from the parent process — the opposite
 * of dotenv's default, which bit here: the Claude desktop app exports
 * ANTHROPIC_BASE_URL=https://api.anthropic.com into everything it launches,
 * and that silently overrode the OpenRouter endpoint set in .env. On a hosting
 * provider there is no .env file, so the host's own variables apply untouched.
 */
import dotenv from 'dotenv';

dotenv.config({ override: true });
