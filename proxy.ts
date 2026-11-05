import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

export async function proxy(request: NextRequest)
{
	return await updateSession(request);
}

export const config = {
	matcher: [
		// robots.txt must reach crawlers without a session (it'd redirect to /login
		// otherwise); same for BotID's challenge paths (withBotId in next.config.ts),
		// which the login page loads before anyone is signed in. Also public: the
		// customer tracking page (/t/<token>) and the cron route (own secret).
		"/((?!_next/static|_next/image|favicon.ico|robots.txt|t/|api/cron/|149e9513-01fa-4fb0-aad4-566afd725d1b/|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
	],
};
