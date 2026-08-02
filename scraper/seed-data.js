/**
 * Seed script — populate broker summary data for FlowTracker demo
 * Run: node seed-data.js
 */

const BROKER_DATA = {
  MG: [
    { stockCode: "BBCA", buyVal: 15200000000, buyLot: 2533333, sellVal: 8300000000, sellLot: 1383333 },
    { stockCode: "BBRI", buyVal: 28500000000, buyLot: 9284000, sellVal: 12100000000, sellLot: 3941000 },
    { stockCode: "BMRI", buyVal: 9800000000, buyLot: 1555555, sellVal: 11200000000, sellLot: 1777778 },
    { stockCode: "TLKM", buyVal: 5200000000, buyLot: 1843972, sellVal: 3100000000, sellLot: 1099291 },
    { stockCode: "GOTO", buyVal: 42000000000, buyLot: 792452830, sellVal: 31000000000, sellLot: 584905660 },
    { stockCode: "ASII", buyVal: 3800000000, buyLot: 893000, sellVal: 5100000000, sellLot: 1200000 },
    { stockCode: "ANTM", buyVal: 18700000000, buyLot: 4628712, sellVal: 7200000000, sellLot: 1782178 },
    { stockCode: "INCO", buyVal: 4300000000, buyLot: 632352, sellVal: 6800000000, sellLot: 1000000 },
    { stockCode: "PGAS", buyVal: 2100000000, buyLot: 1458333, sellVal: 900000000, sellLot: 625000 },
    { stockCode: "INDF", buyVal: 1800000000, buyLot: 240000, sellVal: 2500000000, sellLot: 333333 },
    { stockCode: "ICBP", buyVal: 3200000000, buyLot: 301887, sellVal: 1100000000, sellLot: 103773 },
    { stockCode: "KLBF", buyVal: 950000000, buyLot: 593750, sellVal: 1700000000, sellLot: 1062500 },
    { stockCode: "SMGR", buyVal: 2800000000, buyLot: 718000, sellVal: 3500000000, sellLot: 897000 },
    { stockCode: "EXCL", buyVal: 1200000000, buyLot: 500000, sellVal: 800000000, sellLot: 333333 },
    { stockCode: "UNVR", buyVal: 870000000, buyLot: 382000, sellVal: 1500000000, sellLot: 660000 },
    { stockCode: "BBNI", buyVal: 7300000000, buyLot: 1460000, sellVal: 4200000000, sellLot: 840000 },
    { stockCode: "MDKA", buyVal: 5600000000, buyLot: 2333333, sellVal: 2100000000, sellLot: 875000 },
    { stockCode: "BRIS", buyVal: 3900000000, buyLot: 1560000, sellVal: 2800000000, sellLot: 1120000 },
    { stockCode: "ARTO", buyVal: 1200000000, buyLot: 80000, sellVal: 2700000000, sellLot: 180000 },
    { stockCode: "ESSA", buyVal: 4100000000, buyLot: 8200000, sellVal: 1800000000, sellLot: 3600000 },
    { stockCode: "MEDC", buyVal: 2300000000, buyLot: 1769230, sellVal: 1500000000, sellLot: 1153846 },
    { stockCode: "PTBA", buyVal: 1100000000, buyLot: 407407, sellVal: 600000000, sellLot: 222222 },
  ],
  AK: [
    { stockCode: "BBCA", buyVal: 22000000000, buyLot: 3666667, sellVal: 5500000000, sellLot: 916667 },
    { stockCode: "BBRI", buyVal: 18200000000, buyLot: 5928000, sellVal: 25000000000, sellLot: 8143000 },
    { stockCode: "TLKM", buyVal: 8900000000, buyLot: 3156028, sellVal: 4200000000, sellLot: 1489362 },
    { stockCode: "GOTO", buyVal: 31000000000, buyLot: 584905660, sellVal: 45000000000, sellLot: 849056604 },
    { stockCode: "ANTM", buyVal: 9200000000, buyLot: 2277228, sellVal: 14300000000, sellLot: 3539604 },
    { stockCode: "INCO", buyVal: 7800000000, buyLot: 1147059, sellVal: 3200000000, sellLot: 470588 },
    { stockCode: "BMRI", buyVal: 12300000000, buyLot: 1952381, sellVal: 8700000000, sellLot: 1380952 },
    { stockCode: "UNVR", buyVal: 2100000000, buyLot: 922000, sellVal: 980000000, sellLot: 430000 },
    { stockCode: "MDKA", buyVal: 3400000000, buyLot: 1416667, sellVal: 5100000000, sellLot: 2125000 },
    { stockCode: "PGAS", buyVal: 1500000000, buyLot: 1041667, sellVal: 2800000000, sellLot: 1944444 },
    { stockCode: "BRIS", buyVal: 5200000000, buyLot: 2080000, sellVal: 3100000000, sellLot: 1240000 },
    { stockCode: "EXCL", buyVal: 2700000000, buyLot: 1125000, sellVal: 1200000000, sellLot: 500000 },
  ],
  YP: [
    { stockCode: "GOTO", buyVal: 55000000000, buyLot: 1037735849, sellVal: 38000000000, sellLot: 716981132 },
    { stockCode: "BBRI", buyVal: 15800000000, buyLot: 5146000, sellVal: 19200000000, sellLot: 6254000 },
    { stockCode: "ANTM", buyVal: 12500000000, buyLot: 3093069, sellVal: 8800000000, sellLot: 2178218 },
    { stockCode: "BBCA", buyVal: 8100000000, buyLot: 1350000, sellVal: 12400000000, sellLot: 2066667 },
    { stockCode: "TLKM", buyVal: 6300000000, buyLot: 2234042, sellVal: 7800000000, sellLot: 2765957 },
    { stockCode: "ESSA", buyVal: 7200000000, buyLot: 14400000, sellVal: 3500000000, sellLot: 7000000 },
    { stockCode: "INCO", buyVal: 5100000000, buyLot: 750000, sellVal: 4800000000, sellLot: 705882 },
    { stockCode: "KLBF", buyVal: 2800000000, buyLot: 1750000, sellVal: 1500000000, sellLot: 937500 },
    { stockCode: "SMGR", buyVal: 1900000000, buyLot: 487179, sellVal: 2300000000, sellLot: 589744 },
  ],
  XC: [
    { stockCode: "GOTO", buyVal: 38000000000, buyLot: 716981132, sellVal: 29000000000, sellLot: 547169811 },
    { stockCode: "BBRI", buyVal: 21000000000, buyLot: 6840000, sellVal: 16500000000, sellLot: 5374000 },
    { stockCode: "ANTM", buyVal: 11800000000, buyLot: 2920792, sellVal: 9100000000, sellLot: 2252475 },
    { stockCode: "BBCA", buyVal: 5200000000, buyLot: 866667, sellVal: 7800000000, sellLot: 1300000 },
    { stockCode: "TLKM", buyVal: 4500000000, buyLot: 1595745, sellVal: 5200000000, sellLot: 1843972 },
    { stockCode: "ESSA", buyVal: 3200000000, buyLot: 6400000, sellVal: 5800000000, sellLot: 11600000 },
    { stockCode: "BMRI", buyVal: 7800000000, buyLot: 1238095, sellVal: 6200000000, sellLot: 984127 },
  ],
  XL: [
    { stockCode: "GOTO", buyVal: 48000000000, buyLot: 905660377, sellVal: 35000000000, sellLot: 660377358 },
    { stockCode: "BBRI", buyVal: 19500000000, buyLot: 6351000, sellVal: 14800000000, sellLot: 4820000 },
    { stockCode: "ANTM", buyVal: 8900000000, buyLot: 2202970, sellVal: 12200000000, sellLot: 3019802 },
    { stockCode: "BBCA", buyVal: 11200000000, buyLot: 1866667, sellVal: 6800000000, sellLot: 1133333 },
    { stockCode: "TLKM", buyVal: 3800000000, buyLot: 1347518, sellVal: 4100000000, sellLot: 1453901 },
    { stockCode: "INDF", buyVal: 2200000000, buyLot: 293333, sellVal: 1500000000, sellLot: 200000 },
    { stockCode: "ICBP", buyVal: 4100000000, buyLot: 386792, sellVal: 2800000000, sellLot: 264151 },
    { stockCode: "BRIS", buyVal: 6200000000, buyLot: 2480000, sellVal: 4100000000, sellLot: 1640000 },
  ],
};

async function main() {
  const date = '2026-04-28';
  
  for (const [broker, records] of Object.entries(BROKER_DATA)) {
    try {
      const res = await fetch(`http://localhost:3100/api/broker-summary/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brokerCode: broker, date, records }),
      });
      const json = await res.json();
      console.log(`✅ ${broker}: uploaded ${json.uploaded} records, saved ${json.saved}`);
    } catch (err) {
      console.error(`❌ ${broker}: ${err.message}`);
    }
  }

  console.log('\n🎉 Seeding complete!');
}

main();
