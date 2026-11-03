import { initBotId } from "botid/client/core";

// Vercel BotID: invisible bot check on the forms that call GoTrue sign-in from
// the server. Server Actions POST to the page's own path. The server half is
// checkBotId() in lib/auth/actions.ts; without it this does nothing.
// In `next dev` BotID skips the browser side and checkBotId() answers "human".
initBotId({
	protect: [
		{ path: "/login", method: "POST" },
		{ path: "/account/password", method: "POST" },
	],
});
