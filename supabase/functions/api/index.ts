// Public Edge API: https://<project>.supabase.co/functions/v1/api/v1/...
import { requireCaller } from '../_shared/auth.ts';
import { appError, errorResponse, fromDatabaseError, json, preflight } from '../_shared/http.ts';

type Handler = (req: Request, requestId: string) => Promise<Response>;

const routes: Record<string, Partial<Record<string, Handler>>> = {
  '/v1/bootstrap': {
    GET: async (req, requestId) => {
      const { db } = await requireCaller(req);
      const { data, error } = await db.rpc('get_bootstrap');
      if (error) throw fromDatabaseError(error);
      return json(req, requestId, 200, data);
    },
  },
};

Deno.serve(async (req) => {
  const requestId = crypto.randomUUID();
  if (req.method === 'OPTIONS') return preflight(req);
  try {
    const path = new URL(req.url).pathname.replace(/^.*?\/api(?=\/v1\/)/, '');
    const handler = routes[path]?.[req.method];
    if (!handler) throw appError(404, 'NOT_FOUND');
    return await handler(req, requestId);
  } catch (error) {
    return errorResponse(req, requestId, error);
  }
});
