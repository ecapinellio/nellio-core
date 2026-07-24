import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

const PUBLIC_PATHS = ["/login"];

export async function updateSession(request: NextRequest)
{
	let supabaseResponse = NextResponse.next({ request });

	const supabase = createServerClient(
		process.env.NEXT_PUBLIC_SUPABASE_URL!,
		process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
		{
			cookies: {
				getAll()
				{
					return request.cookies.getAll();
				},
				setAll(cookiesToSet)
				{
					cookiesToSet.forEach(({ name, value }) =>
						request.cookies.set(name, value),
					);
					supabaseResponse = NextResponse.next({ request });
					cookiesToSet.forEach(({ name, value, options }) =>
						supabaseResponse.cookies.set(name, value, options),
					);
				},
			},
		},
	);

	// Required: refreshes the session token so it doesn't expire mid-visit.
	const { data: { user } } = await supabase.auth.getUser();

	const isPublicPath = PUBLIC_PATHS.includes(request.nextUrl.pathname);

	if (!user && !isPublicPath)
	{
		const loginUrl = request.nextUrl.clone();
		loginUrl.pathname = "/login";
		loginUrl.searchParams.set("next", request.nextUrl.pathname);
		return copyCookies(supabaseResponse, NextResponse.redirect(loginUrl));
	}

	if (user && request.nextUrl.pathname === "/login")
	{
		const homeUrl = request.nextUrl.clone();
		homeUrl.pathname = "/";
		homeUrl.search = "";
		return copyCookies(supabaseResponse, NextResponse.redirect(homeUrl));
	}

	return supabaseResponse;
}

// Redirect responses are built fresh, so the session cookies refreshed by
// getUser() above (on the original supabaseResponse) need to be carried
// over explicitly or the refreshed token would be dropped.
function copyCookies(from: NextResponse, to: NextResponse): NextResponse
{
	from.cookies.getAll().forEach((cookie) => to.cookies.set(cookie));
	return to;
}
