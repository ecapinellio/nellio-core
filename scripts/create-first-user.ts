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
 *     [--admin-password "..."] \
 *     [--role admin|operator|driver] \
 *     [--tenant-id "<existing tenant uuid>"]
 *
 * If --admin-password is omitted, a random one is generated and printed
 * once — save it, it is not stored anywhere.
 *
 * --role defaults to "admin" (unchanged default). Pass --tenant-id to
 * attach the new user to an existing tenant instead of creating one —
 * this is how operator/driver test accounts get created for RBAC manual
 * verification (T8g), since otherwise this script could only ever
 * produce a fresh admin in a fresh tenant. --tenant-name is ignored when
 * --tenant-id is given.
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

const VALID_ROLES = ["admin", "operator", "driver"] as const;
type Role = (typeof VALID_ROLES)[number];

function parseRole(value: string | undefined): Role
{
	const role = value ?? "admin";
	if (!(VALID_ROLES as readonly string[]).includes(role))
	{
		throw new Error(`Invalid --role "${role}". Must be one of: ${VALID_ROLES.join(", ")}`);
	}
	return role as Role;
}

async function main()
{
	const { values } = parseArgs({
		options: {
			"tenant-name": { type: "string" },
			"tenant-id": { type: "string" },
			"admin-email": { type: "string" },
			"admin-name": { type: "string" },
			"admin-password": { type: "string" },
			"role": { type: "string" },
		},
	});

	const tenantName = values["tenant-name"];
	const existingTenantId = values["tenant-id"];
	const adminEmail = values["admin-email"];
	const adminName = values["admin-name"];
	const role = parseRole(values["role"]);

	if (!adminEmail || !adminName || (!existingTenantId && !tenantName))
	{
		console.error(
			"Usage: pnpm bootstrap:admin -- --tenant-name <name> --admin-email <email> --admin-name <name> [--admin-password <password>] [--role admin|operator|driver] [--tenant-id <existing tenant uuid>]",
		);
		process.exit(1);
	}

	const generatedPassword = values["admin-password"] ?? generatePassword();

	const supabaseUrl = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
	const serviceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

	const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
		auth: { autoRefreshToken: false, persistSession: false },
	});

	let tenantId = existingTenantId;
	let resolvedTenantName = tenantName;

	if (!tenantId)
	{
		console.log(`Creating tenant "${tenantName}"...`);
		const { data: tenant, error: tenantError } = await supabaseAdmin
			.from("tenants")
			.insert({ name: tenantName! })
			.select()
			.single();

		if (tenantError || !tenant)
		{
			throw new Error(
				`Failed to create tenant. Has the T2 schema migration run yet? ${tenantError?.message}`,
			);
		}

		tenantId = tenant.id;
		resolvedTenantName = tenant.name;
	}
	else
	{
		console.log(`Using existing tenant ${tenantId}...`);
	}

	console.log(`Creating auth user for ${adminEmail} (role: ${role})...`);
	const { data: authUser, error: authError } =
		await supabaseAdmin.auth.admin.createUser({
			email: adminEmail,
			password: generatedPassword,
			email_confirm: true,
			app_metadata: {
				tenant_id: tenantId,
				role,
			},
		});

	if (authError || !authUser.user)
	{
		throw new Error(`Failed to create auth user: ${authError?.message}`);
	}

	console.log("Creating users row...");
	const { error: userRowError } = await supabaseAdmin.from("users").insert({
		id: authUser.user.id,
		tenant_id: tenantId,
		name: adminName,
		role,
	});

	if (userRowError)
	{
		throw new Error(`Failed to create users row: ${userRowError.message}`);
	}

	console.log("\nDone.");
	console.log(`  Tenant:   ${resolvedTenantName ?? tenantId} (${tenantId})`);
	console.log(`  Role:     ${role}`);
	console.log(`  Email:    ${adminEmail}`);
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
