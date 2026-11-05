import { createAdminClient } from "@/lib/supabase/admin";
import { sendPendingNotifications } from "@/lib/notifications/send";

// Vercel Cron (vercel.json) calls this with `Authorization: Bearer $CRON_SECRET`.
export async function GET(request: Request)
{
	const secret = process.env.CRON_SECRET;
	if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`)
	{
		return new Response("Unauthorized", { status: 401 });
	}
	return Response.json(await sendPendingNotifications(createAdminClient()));
}
