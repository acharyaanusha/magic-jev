/**
 * The Vercel entry for POST /api/ask. Vercel routes only POST requests to this
 * export, so the handler needs no method check.
 */
import { handleAsk } from '../packages/server/src/handler.js';

export const POST = (request: Request) => handleAsk(request);
