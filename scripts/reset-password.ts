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
import { readFileSync } from "node:fs";
import { parseEnv, parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { findAuthUserByEmail, resetPasswordForUser } from "@/lib/users/reset-password";

/**
 * Reads the env file itself instead of process.loadEnvFile(): that one
 * lets variables already exported in the shell win, so a stray exported
 * URL could make "--prod" (or local) hit a different project than the file
 * says. Here the file is the only source.
 */
function readEnvFile(path: string): { url: string; serviceKey: string }
{
	const env = parseEnv(readFileSync(path, "utf8"));
	const url = env.NEXT_PUBLIC_SUPABASE_URL;
	const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
	if (!url || !serviceKey)
	{
		throw new Error(`${path} needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY`);
	}
	return { url, serviceKey };
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

	const envFile = values.prod ? ".env.production.local" : ".env.local";
	const { url, serviceKey } = readEnvFile(envFile);

	// Without --prod this must be the local stack (same guard as
	// tests/fixtures.ts) — a .env.local pointed at production would
	// otherwise skip the confirmation below.
	const { host, hostname } = new URL(url);
	if (!values.prod && hostname !== "127.0.0.1" && hostname !== "localhost")
	{
		console.error(`${envFile} points at ${host}, not a local Supabase. Use --prod to target production on purpose.`);
		process.exit(1);
	}

	// Own client, not lib/supabase/admin.ts — that file is "server-only",
	// which throws outside Next's bundler (same as scripts/create-first-user.ts).
	const admin = createClient<Database>(url, serviceKey, {
		auth: { autoRefreshToken: false, persistSession: false },
	});

	const user = await findAuthUserByEmail(admin, values.email);
	if (!user)
	{
		console.error(`No user with email ${values.email} in ${host}`);
		process.exit(1);
	}

	const tenantId = user.app_metadata.tenant_id as string | undefined;
	const { data: tenant } = tenantId
		? await admin.from("tenants").select("name").eq("id", tenantId).maybeSingle()
		: { data: null };

	console.log(`Project: ${host}${values.prod ? "  (PRODUCTION)" : ""}`);
	console.log(`User:    ${user.email} — ${user.app_metadata.role ?? "no role"} at ${tenant?.name ?? "no tenant"}${tenantId ? ` (${tenantId})` : ""}`);

	if (values.prod)
	{
		// Typing the project ref (not just "yes") proves this is the project
		// you meant — a stale or wrong .env.production.local can't slip by.
		const projectRef = hostname.split(".")[0];
		const rl = createInterface({ input: process.stdin, output: process.stdout });
		const answer = await rl.question(`Reset this password and close their sessions? Type the project ref (${projectRef}) to confirm: `);
		rl.close();
		if (answer.trim() !== projectRef)
		{
			console.log("Cancelled. Nothing changed.");
			process.exit(0);
		}
	}

	const { data, error } = await resetPasswordForUser(admin, user);
	if (error || !data)
	{
		throw new Error(error ?? "Reset failed");
	}

	console.log("\nDone.");
	console.log(`  Password: ${data.password}  (shown once; they must change it on next login — clear your terminal after copying)`);
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
