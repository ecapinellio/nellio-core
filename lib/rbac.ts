/**
 * Single source of truth for route access by role, mirroring CLAUDE.md's
 * "Vistas del frontend por rol" table. Consumed by both the middleware
 * (route redirect) and AppShellNav (nav filtering) so the two can't drift
 * apart as routes are added.
 *
 * This is a UX layer, not the security boundary — RLS enforces the real
 * restriction (ADR-006: "el frontend esconde, el backend prohíbe").
 */

export type Role = "admin" | "operator" | "driver";

const ROLES: readonly Role[] = ["admin", "operator", "driver"];

export function isRole(value: string | null | undefined): value is Role
{
	return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

interface RouteRule
{
	prefix: string;
	roles: readonly Role[];
}

// Longest matching prefix wins. Any route not matched here falls back to
// DEFAULT_ROLES — fail-closed (ADR-006: role access is foundational, not
// incremental), so a route someone forgets to list isn't open by default.
const ROUTE_RULES: readonly RouteRule[] = [
	// "/" must stay open to every role — driver needs somewhere to land
	// after login even with no other route available yet.
	{ prefix: "/", roles: ROLES },
	{ prefix: "/orders", roles: ["admin", "operator"] },
	// Own account (change password): everyone, it's about yourself.
	{ prefix: "/account", roles: ROLES },
	// Catalog: same roles as the products RLS policies.
	{ prefix: "/products", roles: ["admin", "operator"] },
	// Reserved namespace for admin-only views ("Administración" row).
	{ prefix: "/admin", roles: ["admin"] },
];

// Admin-only, not ["admin", "operator"]: the old default let an operator
// reach any route nobody remembered to list (eng-review Decision 12).
const DEFAULT_ROLES: readonly Role[] = ["admin"];

function rolesFor(pathname: string): readonly Role[]
{
	let best: RouteRule | undefined;

	for (const rule of ROUTE_RULES)
	{
		const matches = rule.prefix === "/" ? pathname === "/" : pathname.startsWith(rule.prefix);
		if (matches && (!best || rule.prefix.length > best.prefix.length))
		{
			best = rule;
		}
	}

	return best?.roles ?? DEFAULT_ROLES;
}

export function isRouteAllowed(pathname: string, role: string | null | undefined): boolean
{
	if (!isRole(role))
	{
		return false;
	}

	return rolesFor(pathname).includes(role);
}
