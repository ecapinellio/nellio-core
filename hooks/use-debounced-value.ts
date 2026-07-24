import { useEffect, useState } from "react";

export function useDebouncedValue<T>(value: T, delayMs = 275): T
{
	const [debounced, setDebounced] = useState(value);

	useEffect(() =>
	{
		const timer = setTimeout(() => setDebounced(value), delayMs);
		return () => clearTimeout(timer);
	}, [value, delayMs]);

	return debounced;
}
