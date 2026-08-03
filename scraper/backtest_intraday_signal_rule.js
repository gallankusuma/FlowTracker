/**
 * EXP-019 — does the system's own BUY day differ from the IDX intraday base rate?
 *
 * The rule under test is the one requested: enter the morning AFTER a signal,
 * exit same day at -2%, +10%, or the close. The base rate over all 118,463
 * stock-days is -0.673% net per trade (PF 0.48). The only way this rule can
 * work is if the system's selection has positive intraday drift where the
 * average stock has about -0.2%.
 *
 * Entry is the next bar's OPEN, matching the T+1 convention used everywhere
 * else in this codebase. Same-bar ambiguity resolves to STOP.
 */
require('dotenv').config();
const mysql = require('mysql2/promise');
const COST = 0.50;

function evaluate(bars, label, stopPct, tgtPct) {
  let st=0, tg=0, nt=0, sum=0, w=0; const nets=[];
  for (const b of bars) {
    const hs = b.l <= b.o*(1-stopPct/100), ht = b.h >= b.o*(1+tgtPct/100);
    let g;
    if (hs) { g = -stopPct; st++; }
    else if (ht) { g = tgtPct; tg++; }
    else { g = (b.c/b.o-1)*100; nt++; }
    const net = g - COST; sum += net; nets.push(net); if (net>0) w++;
  }
  const n = bars.length || 1;
  const gp = nets.filter(v=>v>0).reduce((s,v)=>s+v,0), gl = nets.filter(v=>v<0).reduce((s,v)=>s+Math.abs(v),0);
  const mean = sum/n;
  const sd = Math.sqrt(nets.reduce((s,v)=>s+(v-mean)**2,0)/Math.max(n-1,1));
  const se = sd/Math.sqrt(n);
  return { label, n: bars.length, stopRate: st/n, tgtRate: tg/n, noneRate: nt/n,
           avgNet: mean, se, t: se>0 ? mean/se : null, pf: gl>0 ? gp/gl : null, winRate: w/n };
}

const row = r => `${r.label.padEnd(26)} ${String(r.n).padStart(7)}  ${(r.stopRate*100).toFixed(1).padStart(6)}%  ${(r.tgtRate*100).toFixed(1).padStart(5)}%  ${r.avgNet.toFixed(3).padStart(8)}  ${(r.se?('±'+r.se.toFixed(3)):'').padStart(8)}  ${(r.t===null?'n/a':r.t.toFixed(2)).padStart(6)}  ${(r.pf===null?'n/a':r.pf.toFixed(3)).padStart(6)}  ${(r.winRate*100).toFixed(1).padStart(5)}%`;

(async () => {
  const p = await mysql.createPool({host:process.env.DB_HOST||'localhost',user:process.env.DB_USER||'erp_user',password:process.env.DB_PASSWORD,database:process.env.DB_NAME||'erp_manufacturing'});

  const [types] = await p.query(
    `SELECT signal_type, COUNT(*) n, MIN(data_date) d0, MAX(data_date) d1
       FROM idx_signal_history GROUP BY signal_type ORDER BY n DESC`);
  console.log('Signal inventory:');
  for (const t of types) console.log(`  ${String(t.signal_type).padEnd(14)} ${String(t.n).padStart(7)}   ${String(t.d0).slice(0,10)} .. ${String(t.d1).slice(0,10)}`);
  console.log('');

  // The bar AFTER the signal date, per ticker, on the shared IHSG trading-date axis.
  const [bars] = await p.query(`
    SELECT s.signal_type, s.data_date,
           n.open_price o, n.high_price h, n.low_price l, n.close_price c
      FROM idx_signal_history s
      JOIN idx_stock_prices n
        ON n.stock_code = s.stock_code
       AND n.date = (SELECT MIN(p2.date) FROM idx_stock_prices p2
                      WHERE p2.stock_code = s.stock_code AND p2.date > s.data_date)
     WHERE n.open_price>0 AND n.high_price>0 AND n.low_price>0 AND n.close_price>0`);

  const norm = b => ({ o:+b.o, h:+b.h, l:+b.l, c:+b.c });
  const buys = bars.filter(b => /BUY/i.test(String(b.signal_type))).map(norm);
  const strong = bars.filter(b => /STRONG\s*BUY/i.test(String(b.signal_type))).map(norm);
  const all = bars.map(norm);

  console.log('Rule as requested: entry next-day open, stop -2%, target +10%, else exit at that day\'s close');
  console.log('label                            n   stopRate  tgtRate   avgNet%        se       t      PF  winRate');
  console.log(row(evaluate(all, 'every signalled day', 2, 10)));
  console.log(row(evaluate(buys, 'BUY + STRONG BUY', 2, 10)));
  console.log(row(evaluate(strong, 'STRONG BUY only', 2, 10)));
  console.log('');
  console.log('Base rate over all 118,463 IDX stock-days for comparison: avgNet -0.673%, PF 0.482');
  console.log('');
  console.log('Same selections, wider stop (8%) and 7% target — the least-bad cell from the sweep:');
  console.log(row(evaluate(buys, 'BUY + STRONG BUY 8/7', 8, 7)));
  console.log('');
  console.log('And the honest comparison — just holding that next day open-to-close, no stop, no target:');
  const oc = bars.filter(b => /BUY/i.test(String(b.signal_type))).map(norm);
  let s=0; for (const b of oc) s += (b.c/b.o-1)*100;
  console.log(`  BUY days, open->close gross: ${(s/Math.max(oc.length,1)).toFixed(3)}%   n=${oc.length}`);
  await p.end();
})();
