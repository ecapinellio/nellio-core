import type { NextConfig } from "next";
import { withBotId } from "botid/next/config";

const nextConfig: NextConfig = {
	async headers()
	{
		return [
			{
				// Private, login-only app: keep every response (pages, the login
				// redirect, assets) out of search indexes, even for crawlers that
				// ignore app/robots.txt.
				source: "/:path*",
				headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }],
			},
		];
	},
};

// Vercel BotID: adds the rewrites its invisible challenge needs (excluded from
// proxy.ts's matcher). Checked in lib/auth/actions.ts.
export default withBotId(nextConfig);
