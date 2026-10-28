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
 *     [--admin-password "..."] [--keep-password] \
 *     [--role admin|operator|driver] \
 *     [--tenant-id "<existing tenant uuid>"]
 *
 * If --admin-password is omitted, a random one is generated and printed
 * once — save it, it is not stored anywhere. Either way the user must pick
 * their own password on first login; pass --keep-password only when the
 * account owner is the one typing --admin-password.
 *
 * --role defaults to "admin" (unchanged default). Pass --tenant-id to
 * attach the new user to an existing tenant instead of creating one —
 * this is how operator/driver test accounts get created for RBAC manual
 * verification (T8g), since otherwise this script could only ever
 * produce a fresh admin in a fresh tenant. --tenant-name is ignored when
 * --tenant-id is given.
 */
import { parseArgs } from "node:util";
import { createClient } from "@supabase/supabase-js";
import { createUserInTenant } from "@/lib/users/create-user";
import { isRole, type Role } from "@/lib/rbac";

// Constructs its own client rather than lib/supabase/admin.ts's
// createAdminClient() — that file is marked "server-only", which throws
// outside Next's own bundler (including under tsx, which runs this script).
function requireEnv(name: string): string
{
	const value = process.env[name];
	if (!value)
	{
		throw new Error(`Missing required env var: ${name}`);
	}
	return value;
}

function parseRole(value: string | undefined): Role
{
	const role = value ?? "admin";
	if (!isRole(role))
	{
		throw new Error(`Invalid --role "${role}". Must be one of: admin, operator, driver`);
	}
	return role;
}

async function main()
{
	// pnpm forwards the `--` from `pnpm bootstrap:admin -- --tenant-name ...`
	// (the form the usage message documents) literally, and parseArgs
	// rejects it as an unexpected positional.
	const { values } = parseArgs({
		args: process.argv.slice(2).filter((arg) => arg !== "--"),
		options: {
			"tenant-name": { type: "string" },
			"tenant-id": { type: "string" },
			"admin-email": { type: "string" },
			"admin-name": { type: "string" },
			"admin-password": { type: "string" },
			"keep-password": { type: "boolean" },
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
			"Usage: pnpm bootstrap:admin -- --tenant-name <name> --admin-email <email> --admin-name <name> [--admin-password <password> [--keep-password]] [--role admin|operator|driver] [--tenant-id <existing tenant uuid>]",
		);
		process.exit(1);
	}

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
	// createdBy: null — this is the bootstrap path, there's no calling admin
	// (that's the whole reason this script exists).
	const { data: created, error } = await createUserInTenant(supabaseAdmin, {
		tenantId: tenantId!,
		email: adminEmail!,
		name: adminName!,
		role,
		createdBy: null,
		password: values["admin-password"],
		mustChangePassword: !(values["keep-password"] && values["admin-password"]),
	});

	if (error || !created)
	{
		throw new Error(`Failed to create user: ${error?.message}`);
	}

	console.log("\nDone.");
	console.log(`  Tenant:   ${resolvedTenantName ?? tenantId} (${tenantId})`);
	console.log(`  Role:     ${role}`);
	console.log(`  Email:    ${adminEmail}`);
	if (!values["admin-password"])
	{
		console.log(`  Password: ${created.password}  (save this — shown once)`);
	}
}

main().catch((error) =>
{
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
