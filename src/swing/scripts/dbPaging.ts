/**
 * PostgREST caps any unpaginated select() at a default row limit (1000) —
 * silently, no error, no indication which rows survived without an
 * explicit order. Hit this for real once already (the market_regime read
 * in an early version of computeIndicators.ts silently truncated 1985 rows
 * to 1000 in undefined order, corrupting every relative-strength value
 * computed from it). Every multi-row Supabase read across the swing
 * scripts goes through this one paginator specifically so that cap can
 * never bite again quietly.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- supabase-js's generic client type
// doesn't unify cleanly across separately-inferred createClient() calls; every caller here only
// ever touches .from().select().order().range(), so the precision isn't worth fighting for.
export async function fetchAllPages<T>(
  supabase: any, table: string, select: string, orderBy: [string, boolean][], filter?: (q: any) => any,
): Promise<T[]> {
  const PAGE = 1000;
  const rows: T[] = [];
  let from = 0;
  for (;;) {
    let query = supabase.from(table).select(select);
    for (const [col, asc] of orderBy) query = query.order(col, { ascending: asc });
    if (filter) query = filter(query);
    const { data, error } = await query.range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    rows.push(...(data as T[]));
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return rows;
}
