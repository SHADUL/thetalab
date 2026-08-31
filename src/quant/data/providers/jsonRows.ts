/**
 * A provider-agnostic adapter for any tabular source: thetalab's
 * chain_bundle.json, an NSE chain response, a CSV parsed to objects, a broker
 * REST payload. You supply a column map; nothing about the shape is assumed.
 *
 * This is the intended way to wire the existing bhavcopy pipeline in without
 * the engine ever learning what a bhavcopy is.
 */

import type { ChainRequest, ProviderAdapter, RawChainPayload, RawOptionRow } from '../adapter.ts';
import type { ChainSource, ContractSpec, EpochMs, PricingContext } from '../../types.ts';

/** Maps your source's field names onto the raw row fields. */
export type ColumnMap = Partial<Record<keyof RawOptionRow, string>> &
  Pick<Required<Partial<Record<keyof RawOptionRow, string>>>, 'right' | 'strike' | 'expiry'>;

export interface JsonRowsConfig {
  id: string;
  kind: ChainSource['kind'];
  contract: ContractSpec;
  columns: ColumnMap;
  /** Returns the rows for a request. Sync or async; fetch, import, whatever. */
  load: (req: ChainRequest) => Promise<Record<string, unknown>[]> | Record<string, unknown>[];
  /** Returns spot/futures/rate for the session. */
  context: (
    req: ChainRequest,
    rows: Record<string, unknown>[],
  ) => Partial<PricingContext> & { valuationTime: EpochMs };
  note?: string;
}

export function jsonRowsAdapter(cfg: JsonRowsConfig): ProviderAdapter {
  const pick = (row: Record<string, unknown>, key: keyof RawOptionRow) => {
    const col = cfg.columns[key];
    return col === undefined ? undefined : (row[col] as RawOptionRow[typeof key]);
  };

  return {
    id: cfg.id,
    kind: cfg.kind,
    async fetchChain(req: ChainRequest): Promise<RawChainPayload> {
      const rows = await cfg.load(req);
      const context = cfg.context(req, rows);

      const mapped: RawOptionRow[] = rows.map((row) => ({
        right: pick(row, 'right') as RawOptionRow['right'],
        strike: pick(row, 'strike') as RawOptionRow['strike'],
        expiry: pick(row, 'expiry') as RawOptionRow['expiry'],
        asOf: pick(row, 'asOf'),
        bid: pick(row, 'bid'),
        ask: pick(row, 'ask'),
        last: pick(row, 'last'),
        settle: pick(row, 'settle'),
        openInterest: pick(row, 'openInterest'),
        oiChange: pick(row, 'oiChange'),
        volume: pick(row, 'volume'),
        iv: pick(row, 'iv'),
        delta: pick(row, 'delta'),
        gamma: pick(row, 'gamma'),
        theta: pick(row, 'theta'),
        vega: pick(row, 'vega'),
        rho: pick(row, 'rho'),
      }));

      const filtered =
        req.expiries && req.expiries.length > 0
          ? mapped.filter((r) => {
              const e = typeof r.expiry === 'number' ? r.expiry : Date.parse(String(r.expiry));
              return req.expiries!.includes(e);
            })
          : mapped;

      return {
        source: {
          providerId: cfg.id,
          kind: cfg.kind,
          retrievedAt: Date.now(),
          note: cfg.note,
        },
        contract: cfg.contract,
        context,
        rows: filtered,
      };
    },
  };
}
