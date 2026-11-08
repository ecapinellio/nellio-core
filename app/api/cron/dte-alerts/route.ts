import { createAdminClient } from "@/lib/supabase/admin";
import { sendDteAlerts } from "@/lib/dte/alerts";

// Vercel Cron, once a day (vercel.json): admins hear about DTEs nobody fixed.
export async function GET(request: Request)
{
	const secret = process.env.CRON_SECRET;
	if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`)
	{
		return new Response("Unauthorized", { status: 401 });
	}
	return Response.json(await sendDteAlerts(createAdminClient()));
}
