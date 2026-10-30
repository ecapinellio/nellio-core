/**
 * Gives any user a new temporary password — the platform owner's way back in
 * when someone (a client's first admin, or yourself) loses theirs. Admins
 * restore their own team from /admin/users instead.
 *
 * Usage:
 *   pnpm reset:password --email "milo@ectec.com"          # local (.env.local)
 *   pnpm reset:password --email "milo@ectec.com" --prod   # production (.env.production.local, asks to confirm)
 *
 * The new password is printed once and must be replaced on next login.
 * Every session the user had is closed.
 */
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { resetPasswordByEmail, findAuthUserByEmail } from "@/lib/users/reset-password";

// Own client, not lib/supabase/admin.ts — that file is "server-only", which
// throws outside Next's bundler (same as scripts/create-first-user.ts).
function requireEnv(name: string): string
{
	const value = process.env[name];
	if (!value)
	{
		throw new Error(`Missing required env var: ${name}`);
	}
	return value;
}

async function main()
{
	// pnpm forwards a literal `--`; parseArgs would reject it.
	const { values } = parseArgs({
		args: process.argv.slice(2).filter((arg) => arg !== "--"),
		options: {
			email: { type: "string" },
			prod: { type: "boolean" },
		},
	});

	if (!values.email)
	{
		console.error("Usage: pnpm reset:password --email <email> [--prod]");
		process.exit(1);
	}

	process.loadEnvFile(values.prod ? ".env.production.local" : ".env.local");
	const supabaseUrl = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
	const admin = createClient<Database>(supabaseUrl, requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
		auth: { autoRefreshToken: false, persistSession: false },
	});

	console.log(`Project: ${new URL(supabaseUrl).host}${values.prod ? "  (PRODUCTION)" : ""}`);

	const user = await findAuthUserByEmail(admin, values.email);
	if (!user)
	{
		console.error(`No user with email ${values.email}`);
		process.exit(1);
	}
	console.log(`User:    ${user.email} (role: ${user.app_metadata.role ?? "?"}, tenant: ${user.app_metadata.tenant_id ?? "?"})`);

	if (values.prod)
	{
		const rl = createInterface({ input: process.stdin, output: process.stdout });
		const answer = await rl.question("Reset this user's password in PRODUCTION and close their sessions? Type yes: ");
		rl.close();
		if (answer.trim().toLowerCase() !== "yes")
		{
			console.log("Cancelled. Nothing changed.");
			process.exit(0);
		}
	}

	const { data, error } = await resetPasswordByEmail(admin, values.email);
	if (error || !data)
	{
		throw new Error(error ?? "Reset failed");
	}

	console.log("\nDone.");
	console.log(`  Password: ${data.password}  (save this — shown once; they must change it on next login)`);
	if (data.banned)
	{
		console.log("  Note: this user is DEACTIVATED and still can't sign in. Reactivate them in /admin/users.");
	}
}

main().catch((error) =>
{
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
