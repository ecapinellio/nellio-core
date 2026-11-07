import { createAdminClient } from "@/lib/supabase/admin";
import { processPendingDtes } from "@/lib/dte/process";

// Vercel Cron (vercel.json) calls this with `Authorization: Bearer $CRON_SECRET` (ADR-015).
export async function GET(request: Request)
{
	const secret = process.env.CRON_SECRET;
	if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`)
	{
		return new Response("Unauthorized", { status: 401 });
	}
	return Response.json(await processPendingDtes(createAdminClient()));
}
