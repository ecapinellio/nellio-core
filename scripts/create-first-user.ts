/**
 * Creates the first tenant + first admin user (the platform owner's
 * onboarding script per CLAUDE.md §6). A user cannot create itself —
 * this runs server-side with the service_role key, never from the app.
 *
 * Requires the `tenants`/`users` tables (T2 schema migration) to exist.
 *
 * Usage:
 *   pnpm bootstrap:admin \
 *     --tenant-name "ECTEC" \
 *     --admin-email "milo@ectec.com" \
 *     --admin-name "Milo" \
 *     [--admin-password "..."]
 *
 * If --admin-password is omitted, a random one is generated and printed
 * once — save it, it is not stored anywhere.
 */
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { createClient } from "@supabase/supabase-js";

function requireEnv(name: string): string
{
	const value = process.env[name];
	if (!value)
	{
		throw new Error(`Missing required env var: ${name}`);
	}
	return value;
}

function generatePassword(): string
{
	return randomBytes(18).toString("base64url");
}

async function main()
{
	const { values } = parseArgs({
		options: {
			"tenant-name": { type: "string" },
			"admin-email": { type: "string" },
			"admin-name": { type: "string" },
			"admin-password": { type: "string" },
		},
	});

	const tenantName = values["tenant-name"];
	const adminEmail = values["admin-email"];
	const adminName = values["admin-name"];

	if (!tenantName || !adminEmail || !adminName)
	{
		console.error(
			"Usage: pnpm bootstrap:admin -- --tenant-name <name> --admin-email <email> --admin-name <name> [--admin-password <password>]",
		);
		process.exit(1);
	}

	const generatedPassword = values["admin-password"] ?? generatePassword();

	const supabaseUrl = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
	const serviceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

	const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
		auth: { autoRefreshToken: false, persistSession: false },
	});

	console.log(`Creating tenant "${tenantName}"...`);
	const { data: tenant, error: tenantError } = await supabaseAdmin
		.from("tenants")
		.insert({ name: tenantName })
		.select()
		.single();

	if (tenantError || !tenant)
	{
		throw new Error(
			`Failed to create tenant. Has the T2 schema migration run yet? ${tenantError?.message}`,
		);
	}

	console.log(`Creating auth user for ${adminEmail}...`);
	const { data: authUser, error: authError } =
		await supabaseAdmin.auth.admin.createUser({
			email: adminEmail,
			password: generatedPassword,
			email_confirm: true,
			app_metadata: {
				tenant_id: tenant.id,
				role: "admin",
			},
		});

	if (authError || !authUser.user)
	{
		throw new Error(`Failed to create auth user: ${authError?.message}`);
	}

	console.log("Creating users row...");
	const { error: userRowError } = await supabaseAdmin.from("users").insert({
		id: authUser.user.id,
		tenant_id: tenant.id,
		name: adminName,
		role: "admin",
	});

	if (userRowError)
	{
		throw new Error(`Failed to create users row: ${userRowError.message}`);
	}

	console.log("\nDone.");
	console.log(`  Tenant:   ${tenantName} (${tenant.id})`);
	console.log(`  Admin:    ${adminEmail}`);
	if (!values["admin-password"])
	{
		console.log(`  Password: ${generatedPassword}  (save this — shown once)`);
	}
}

main().catch((error) =>
{
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
