import { sql, type SQL } from 'drizzle-orm';

/**
 * Binds a JS array as a real Postgres array.
 *
 * Interpolating an array directly into a `sql` template expands it into a row
 * constructor — `($1, $2, $3)` — which is not an array at all. Routing through
 * JSON gives one bind parameter that Postgres unpacks into a genuine `text[]`,
 * and it stays correct for empty arrays and for values containing commas,
 * quotes or braces.
 *
 * The `ARRAY(...)` constructor matters: a plain scalar subquery returning
 * text[] is ambiguous next to `ANY`/`ALL`, which parse `(subquery)` as the
 * set form and then fail with `operator does not exist: text <> text[]`.
 */
export function textArray(values: readonly string[]): SQL {
	return sql`ARRAY(select value from jsonb_array_elements_text(${JSON.stringify(values)}::jsonb) as t(value))`;
}

/** Same, for timestamps supplied as ISO strings. */
export function timestamptzArray(values: readonly string[]): SQL {
	return sql`ARRAY(select value::timestamptz from jsonb_array_elements_text(${JSON.stringify(values)}::jsonb) as t(value))`;
}

/** `x = ANY(...)`; false for every x when the array is empty. */
export function anyOf(values: readonly string[]): SQL {
	return sql`any(${textArray(values)})`;
}

/** `x <> ALL(...)`: true when x is absent — and true for all x when empty. */
export function notIn(values: readonly string[]): SQL {
	return sql`<> all(${textArray(values)})`;
}
