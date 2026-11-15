// BTC Race Bot — cbBTC/USDC minute-bar dip-buy strategy.
// Buys when price drops X% from the running high, sells at profit target,
// stop loss, or max hold. Deterministic, long only, stdlib only via kit shim.
//
// Runs under `node /bot/main.ts` with vendor/makefun-bars.ts at /bot.
import { BPS, runBars, type BarsState, type Batch, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

const DIP_PCT = 500;      // 5.0% dip from running high -> enter
const EXIT_PCT = 200;     // 2.0% profit -> exit
const STOP_PCT = 400;     // 4.0% loss -> exit
const MAX_HOLD_BARS = 360; // 6 hours max hold
const MAX_SLIPPAGE_BPS = 200; // 2% slippage cap

interface Entry {
  price: bigint; // entry price (raw, price_scale 5)
  barsHeld: number;
}

let runningHigh = 0n;
let entry: Entry | null = null;

function pctBps(price: bigint, ref: bigint): bigint {
  if (ref === 0n) return 0n;
  return ((price - ref) * BPS) / ref;
}

await runBars({
  onBatch(state, _batch) {
    const symbol = SYMBOL;
    const close = state.close(symbol);
    if (close === null) return [];

    // Update running high from closes
    if (close > runningHigh) runningHigh = close;

    const orders: (BuyInput | SellInput)[] = [];

    if (entry !== null) {
      entry.barsHeld++;
      const retBps = pctBps(close, entry.price);
      const atProfit = retBps >= BigInt(EXIT_PCT);
      const atStop = retBps <= -BigInt(STOP_PCT);
      const atMaxHold = entry.barsHeld >= MAX_HOLD_BARS;
      if (atProfit || atStop || atMaxHold) {
        const held = state.positions.get(symbol);
        if (held !== undefined && held.qty > 0n) {
          orders.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
          entry = null;
        }
        return orders;
      }
      return orders;
    }

    // Not holding: enter on dip from running high
    if (runningHigh > 0n) {
      const dipBps = ((runningHigh - close) * BPS) / runningHigh; // positive when close < runningHigh
      if (dipBps >= BigInt(DIP_PCT)) {
        const weightRoom = state.weightRoom(symbol);
        const minNotional = BigInt(state.hello.fees.min_notional_quote_units);
        let slice = state.cash;
        if (weightRoom < slice) slice = weightRoom;
        if (slice < minNotional) return orders;
        if (state.cash < slice) return orders;
        entry = { price: close, barsHeld: 0 };
        orders.push({ side: 'buy', symbol, notional_quote_units: slice, max_slippage_bps: MAX_SLIPPAGE_BPS });
      }
    }
    return orders;
  },
});
