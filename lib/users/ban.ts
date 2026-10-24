// Deactivation is a Supabase Auth ban (RBAC slice 3, eng-review Decision 1).
// GoTrue's duration format has no "forever"; ~100 years stands in for it,
// and "none" lifts the ban.
export const BAN_FOREVER = "876000h";
export const UNBAN = "none";

/**
 * banned_until is a timestamp, not a flag: GoTrue keeps a past value
 * around after a timed ban expires, so "not null" is not "banned".
 */
export function isBanned(bannedUntil: string | null | undefined, now: Date = new Date()): boolean
{
	if (!bannedUntil)
	{
		return false;
	}
	const until = new Date(bannedUntil);
	return !Number.isNaN(until.getTime()) && until.getTime() > now.getTime();
}
