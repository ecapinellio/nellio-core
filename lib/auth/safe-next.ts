/**
 * Where to send the user after login: only a path inside this app. A
 * user-controlled `next` passed straight to redirect() would be an open
 * redirect. Browsers read "\" as "/", so "/\evil.com" means "//evil.com" —
 * checking the string isn't enough; resolve it and compare the origin.
 */
export function safeNextPath(next: unknown): string
{
	if (typeof next !== "string" || !next.startsWith("/") || next.startsWith("//") || next.includes("\\"))
	{
		return "/";
	}

	try
	{
		const url = new URL(next, "http://n");
		if (url.origin !== "http://n")
		{
			return "/";
		}
		// URL resolves dot segments: "/.//evil.com" comes out as "//evil.com".
		// Check what's returned, not just what came in.
		const path = `${url.pathname}${url.search}${url.hash}`;
		return path.startsWith("/") && !path.startsWith("//") && !path.includes("\\") ? path : "/";
	}
	catch
	{
		return "/";
	}
}
