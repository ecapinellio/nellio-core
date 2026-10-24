import type { Role } from "@/lib/rbac";

// UI names for each role (design review D11). The role values themselves
// ("driver", etc.) stay as-is in code, JWT and DB — only the label changes.
export const ROLE_LABELS: Record<Role, string> = {
	admin: "Administrador",
	operator: "Operador",
	driver: "Repartidor",
};

export function roleLabel(role: string): string
{
	return ROLE_LABELS[role as Role] ?? role;
}
