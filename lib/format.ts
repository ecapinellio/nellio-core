/**
 * Presentation-only formatting helpers — not business math (see
 * lib/order-math.ts's own header for that distinction), just how values
 * render. Shared across components so there's one place to get a format
 * right, not N copies that can silently drift apart.
 */

/** dd-mm-yyyy hh:mm:ss in the viewer's local time, not `toLocaleDateString`'s locale-dependent shorthand — an operator needs the exact minute an order landed, not just the day. */
export function formatOrderTimestamp(iso: string): string
{
	const d = new Date(iso);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** dd-mm-yyyy, same order/padding as formatOrderTimestamp, for dates where the time adds nothing (e.g. when a user account was created). */
export function formatDate(iso: string): string
{
	const d = new Date(iso);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()}`;
}

const CHANNEL_LABELS: Record<string, string> = {
	whatsapp: "WhatsApp",
	portal: "Portal",
};

/** Mirrors orders.channel's db check constraint — falls back to the raw value for a channel this map doesn't know about yet, rather than hiding it. */
export function formatChannel(channel: string): string
{
	return CHANNEL_LABELS[channel] ?? channel;
}
