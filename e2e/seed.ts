import { readFileSync } from "node:fs";
import type { Role } from "@/tests/integration/fixtures";

export { TEST_PASSWORD } from "@/tests/integration/fixtures";

export const SEED_FILE = "e2e/.auth/seed.json";

/** Data global-setup creates for the run; specs read it, never hard-code ids. */
export interface Seed
{
	emails: Record<Role, string>;
	/** Operator used only by the logout test (logout revokes all of a user's sessions). */
	logoutEmail: string;
	customerName: string;
	productName: string;
	assignedOrderId: string;
	trackingToken: string;
}

export const seed = (): Seed => JSON.parse(readFileSync(SEED_FILE, "utf8"));

/** storageState file per role, written by auth.setup.ts. */
export const authFile = (role: Role) => `e2e/.auth/${role}.json`;
