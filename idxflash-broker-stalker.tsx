'use client';

import { useState } from 'react';
import { Search, TrendingUp, TrendingDown, Minus, Calendar, BarChart3, Eye } from 'lucide-react';

const API_BASE = 'http://76.13.22.155:3100';

const BROKER_LIST = [
  { code: 'MG', name: 'Mirae Asset Sekuritas' }, { code: 'CC', name: 'Mandiri Sekuritas' },
  { code: 'YP', name: 'Indo Premier Sekuritas' }, { code: 'AK', name: 'UBS Sekuritas Indonesia' },
  { code: 'ZP', name: 'Kim Eng Sekuritas (Maybank)' }, { code: 'PD', name: 'CGS-CIMB Sekuritas' },
  { code: 'DH', name: 'CLSA Sekuritas Indonesia' }, { code: 'RX', name: 'Macquarie Sekuritas' },
  { code: 'BK', name: 'BNI Sekuritas' }, { code: 'NI', name: 'BCA Sekuritas' },
  { code: 'KK', name: 'JP Morgan Sekuritas' }, { code: 'LG', name: 'Deutsche Sekuritas' },
  { code: 'GR', name: 'Bahana Sekuritas' }, { code: 'TP', name: 'Morgan Stanley Sekuritas' },
  { code: 'IF', name: 'Trimegah Sekuritas' }, { code: 'DR', name: 'Credit Suisse Sekuritas' },
  { code: 'CP', name: 'Citigroup Sekuritas' }, { code: 'AI', name: 'Danareksa Sekuritas' },
];

interface BrokerRow {
  ticker: string; action: string;
  buyVal: string; buyLot: string; buyAvg: number;
  sellVal: string; sellLot: string; sellAvg: number;
  netVal: string; rawBuyVal: number; rawSellVal: number; rawNetVal: number;
  daysActive?: number;
}

function getRecentTradingDays(count: number) {
  const days: { label: string; value: string }[] = [];
  const cursor = new Date();
  const labels = ['Hari ini', 'Kemarin', '2 hari lalu', '3 hari lalu'];
  let idx = 0;
  while (days.length < count && idx < 14) {
    if (cursor.getDay() !== 0 && cursor.getDay() !== 6) {
      days.push({ label: labels[days.length] || cursor.toISOString().split('T')[0], value: cursor.toISOString().split('T')[0] });
    }
    cursor.setDate(cursor.getDate() - 1);
    idx++;
  }
  return days;
}

export default function BrokerStalkerPage() {
  const recentDays = getRecentTradingDays(6);
  const [brokerCode, setBrokerCode] = useState('');
  const [rangeMode, setRangeMode] = useState(false);
  const [dateFrom, setDateFrom] = useState(recentDays[1]?.value || recentDays[0]?.value || '');
  const [dateTo, setDateTo] = useState(recentDays[1]?.value || recentDays[0]?.value || '');
  const [data, setData] = useState<BrokerRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [meta, setMeta] = useState<{ date: string; mode?: string; count: number; buyCount: number; sellCount: number } | null>(null);
  const [filter, setFilter] = useState<'ALL' | 'BUY' | 'SELL'>('ALL');
  const [searchTicker, setSearchTicker] = useState('');

  const minDate = (() => { const d = new Date(); d.setMonth(d.getMonth() - 10); d.setDate(d.getDate() + 14); return d.toISOString().split('T')[0]; })();
  const maxDate = new Date().toISOString().split('T')[0];

  const applyPreset = (p: string) => {
    const to = recentDays[1]?.value || recentDays[0]?.value || '';
    setDateTo(to); setRangeMode(true);
    const d = new Date(to);
    if (p === '1W') d.setDate(d.getDate() - 6);
    else if (p === '2W') d.setDate(d.getDate() - 13);
    else if (p === '1M') d.setMonth(d.getMonth() - 1);
    setDateFrom(d.toISOString().split('T')[0]);
  };

  const handleSearch = async (code?: string) => {
    const c = (code || brokerCode).toUpperCase().trim();
    if (c.length < 2) return;
    setBrokerCode(c); setLoading(true); setData(null); setMeta(null);
    try {
      let url = `${API_BASE}/api/broker-summary?code=${c}`;
      if (rangeMode && dateFrom && dateTo) url += `&from=${dateFrom}&to=${dateTo}`;
      else url += `&date=${dateFrom}`;
      const res = await fetch(url);
      const json = await res.json();
      setData(json.data || []);
      setMeta({ date: json.date, mode: json.mode, count: json.count, buyCount: json.buyCount, sellCount: json.sellCount });
    } catch {
      setData([]);
    } finally { setLoading(false); }
  };

  const filtered = data?.filter(d => {
    if (filter !== 'ALL' && d.action !== filter) return false;
    if (searchTicker && !d.ticker.includes(searchTicker.toUpperCase())) return false;
    return true;
  }) || [];

  const fmtVal = (n: number) => {
    if (Math.abs(n) >= 1e12) return (n / 1e12).toFixed(1) + 'T';
    if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(1) + 'B';
    if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(0) + 'M';
    return (n / 1e3).toFixed(0) + 'K';
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
          <Eye className="w-6 h-6 text-emerald-500" /> Broker Stalker
        </h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          Lacak aktivitas broker — lihat saham yang sedang diakumulasi atau didistribusi
        </p>
      </div>

      {/* Controls Card */}
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-5">
        <div className="flex flex-wrap items-end gap-4">
          {/* Broker Code */}
          <div>
            <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 mb-1.5 uppercase tracking-wider">Broker Code</label>
            <input value={brokerCode} onChange={e => setBrokerCode(e.target.value.toUpperCase().slice(0, 2))}
              onKeyDown={e => e.key === 'Enter' && handleSearch()}
              placeholder="MG" className="w-20 px-3 py-2 text-center text-lg font-bold rounded-lg border border-gray-300 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 outline-none" />
          </div>

          {/* Mode Toggle */}
          <div>
            <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 mb-1.5 uppercase tracking-wider">Mode</label>
            <div className="flex gap-1">
              <button onClick={() => { setRangeMode(false); setDateTo(dateFrom); }}
                className={`px-3 py-2 text-xs font-bold rounded-lg border transition-colors ${!rangeMode ? 'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400 border-emerald-300 dark:border-emerald-700' : 'bg-gray-50 dark:bg-gray-800 text-gray-500 dark:text-gray-400 border-gray-300 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-700'}`}>
                📅 1 Hari
              </button>
              <button onClick={() => { setRangeMode(true); if (dateFrom === dateTo) applyPreset('1W'); }}
                className={`px-3 py-2 text-xs font-bold rounded-lg border transition-colors ${rangeMode ? 'bg-orange-50 dark:bg-orange-900/30 text-orange-700 dark:text-orange-400 border-orange-300 dark:border-orange-700' : 'bg-gray-50 dark:bg-gray-800 text-gray-500 dark:text-gray-400 border-gray-300 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-700'}`}>
                📊 Akumulasi
              </button>
            </div>
          </div>

          {/* Date Picker(s) */}
          <div>
            <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 mb-1.5 uppercase tracking-wider">
              {rangeMode ? 'Periode' : 'Tanggal'}
            </label>
            <div className="flex items-center gap-2 flex-wrap">
              {rangeMode ? (
                <>
                  <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} min={minDate} max={dateTo || maxDate}
                    className="px-2 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-white outline-none focus:ring-2 focus:ring-orange-500" />
                  <span className="text-orange-500 font-bold">→</span>
                  <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} min={dateFrom || minDate} max={maxDate}
                    className="px-2 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-white outline-none focus:ring-2 focus:ring-orange-500" />
                  {['1W', '2W', '1M'].map(p => (
                    <button key={p} onClick={() => applyPreset(p)}
                      className="px-2 py-1.5 text-xs font-semibold rounded-md bg-orange-50 dark:bg-orange-900/20 text-orange-600 dark:text-orange-400 border border-orange-200 dark:border-orange-800 hover:bg-orange-100 dark:hover:bg-orange-900/40 transition-colors">
                      {p === '1W' ? '1 Minggu' : p === '2W' ? '2 Minggu' : '1 Bulan'}
                    </button>
                  ))}
                </>
              ) : (
                <>
                  <input type="date" value={dateFrom} onChange={e => { setDateFrom(e.target.value); setDateTo(e.target.value); }} min={minDate} max={maxDate}
                    className="px-2 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-white outline-none focus:ring-2 focus:ring-emerald-500" />
                  {recentDays.slice(0, 3).map(d => (
                    <button key={d.value} onClick={() => { setDateFrom(d.value); setDateTo(d.value); }}
                      className={`px-2 py-1.5 text-xs font-semibold rounded-md border transition-colors ${dateFrom === d.value ? 'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400 border-emerald-300 dark:border-emerald-700' : 'bg-gray-50 dark:bg-gray-800 text-gray-500 dark:text-gray-400 border-gray-300 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-700'}`}>
                      {d.label}
                    </button>
                  ))}
                </>
              )}
            </div>
          </div>

          {/* Run Button */}
          <button onClick={() => handleSearch()} disabled={loading || brokerCode.length < 2}
            className={`px-5 py-2.5 rounded-lg font-bold text-sm text-white transition-all ${loading || brokerCode.length < 2 ? 'bg-gray-400 cursor-not-allowed' : rangeMode ? 'bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-600 hover:to-amber-600 shadow-lg shadow-orange-500/25' : 'bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-600 hover:to-teal-600 shadow-lg shadow-emerald-500/25'}`}>
            {loading ? '⏳ Loading...' : rangeMode ? '📊 Run Akumulasi' : '🔍 Run Stalker'}
          </button>
        </div>

        {/* Quick Broker Buttons */}
        <div className="mt-4 pt-4 border-t border-gray-100 dark:border-gray-800">
          <p className="text-xs text-gray-400 dark:text-gray-500 mb-2 font-medium">Quick Select Broker:</p>
          <div className="flex flex-wrap gap-1.5">
            {BROKER_LIST.map(b => (
              <button key={b.code} onClick={() => { setBrokerCode(b.code); handleSearch(b.code); }}
                className="px-2 py-1 text-xs font-semibold rounded-md bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 hover:text-emerald-700 dark:hover:text-emerald-400 border border-gray-200 dark:border-gray-700 transition-colors"
                title={b.name}>
                {b.code}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Results */}
      {loading && (
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-12 text-center">
          <div className="animate-spin w-8 h-8 border-4 border-emerald-500 border-t-transparent rounded-full mx-auto mb-3" />
          <p className="text-gray-500 dark:text-gray-400">Mengambil data broker {brokerCode}...</p>
        </div>
      )}

      {data && !loading && (
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800">
          {/* Results Header */}
          <div className="p-5 border-b border-gray-100 dark:border-gray-800">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div>
                <h2 className="text-lg font-bold text-gray-900 dark:text-white">
                  {meta?.mode === 'range' && <span className="text-orange-500">📊 </span>}
                  Broker {brokerCode} — {BROKER_LIST.find(b => b.code === brokerCode)?.name || 'Unknown'}
                </h2>
                <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
                  {meta?.date || '—'} · {meta?.count || 0} saham
                </p>
              </div>
              <div className="flex gap-2">
                {(['ALL', 'BUY', 'SELL'] as const).map(f => (
                  <button key={f} onClick={() => setFilter(f)}
                    className={`px-3 py-1.5 text-xs font-bold rounded-lg border transition-colors ${filter === f
                      ? f === 'BUY' ? 'bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-400 border-green-300 dark:border-green-700'
                        : f === 'SELL' ? 'bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-400 border-red-300 dark:border-red-700'
                        : 'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400 border-emerald-300 dark:border-emerald-700'
                      : 'bg-gray-50 dark:bg-gray-800 text-gray-500 dark:text-gray-400 border-gray-300 dark:border-gray-700'}`}>
                    {f === 'ALL' ? `Semua (${meta?.count || 0})` : f === 'BUY' ? `🟢 Buy (${meta?.buyCount || 0})` : `🔴 Sell (${meta?.sellCount || 0})`}
                  </button>
                ))}
              </div>
            </div>
            {/* Ticker search */}
            <div className="mt-3 relative max-w-xs">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input value={searchTicker} onChange={e => setSearchTicker(e.target.value.toUpperCase())}
                placeholder="Filter ticker..." className="w-full pl-9 pr-3 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-white outline-none focus:ring-2 focus:ring-emerald-500" />
            </div>
          </div>

          {/* Stats Summary */}
          {data.length > 0 && (
            <div className="grid grid-cols-3 border-b border-gray-100 dark:border-gray-800">
              <div className="p-4 text-center border-r border-gray-100 dark:border-gray-800">
                <p className="text-xs text-gray-400 uppercase font-semibold">Total Net Buy</p>
                <p className="text-xl font-bold text-green-600 dark:text-green-400">
                  {fmtVal(data.filter(d => d.rawNetVal > 0).reduce((s, d) => s + d.rawNetVal, 0))}
                </p>
              </div>
              <div className="p-4 text-center border-r border-gray-100 dark:border-gray-800">
                <p className="text-xs text-gray-400 uppercase font-semibold">Total Net Sell</p>
                <p className="text-xl font-bold text-red-600 dark:text-red-400">
                  {fmtVal(Math.abs(data.filter(d => d.rawNetVal < 0).reduce((s, d) => s + d.rawNetVal, 0)))}
                </p>
              </div>
              <div className="p-4 text-center">
                <p className="text-xs text-gray-400 uppercase font-semibold">Net Position</p>
                <p className={`text-xl font-bold ${data.reduce((s, d) => s + d.rawNetVal, 0) >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                  {fmtVal(data.reduce((s, d) => s + d.rawNetVal, 0))}
                </p>
              </div>
            </div>
          )}

          {/* Table */}
          {filtered.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 dark:bg-gray-800/50 text-xs uppercase text-gray-500 dark:text-gray-400">
                    <th className="px-4 py-3 text-left font-semibold">Ticker</th>
                    <th className="px-4 py-3 text-center font-semibold">Action</th>
                    <th className="px-4 py-3 text-right font-semibold">Buy Val</th>
                    <th className="px-4 py-3 text-right font-semibold">Buy Lot</th>
                    <th className="px-4 py-3 text-right font-semibold">Sell Val</th>
                    <th className="px-4 py-3 text-right font-semibold">Sell Lot</th>
                    <th className="px-4 py-3 text-right font-semibold">Net Val</th>
                    {meta?.mode === 'range' && <th className="px-4 py-3 text-center font-semibold">Days</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                  {filtered.map((row, i) => (
                    <tr key={row.ticker} className="hover:bg-gray-50 dark:hover:bg-gray-800/30 transition-colors">
                      <td className="px-4 py-3 font-bold text-gray-900 dark:text-white">{row.ticker}</td>
                      <td className="px-4 py-3 text-center">
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold ${
                          row.action === 'BUY' ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400'
                          : row.action === 'SELL' ? 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400'
                          : 'bg-gray-100 dark:bg-gray-800 text-gray-500'}`}>
                          {row.action === 'BUY' ? <TrendingUp className="w-3 h-3" /> : row.action === 'SELL' ? <TrendingDown className="w-3 h-3" /> : <Minus className="w-3 h-3" />}
                          {row.action}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-green-600 dark:text-green-400">{row.buyVal}</td>
                      <td className="px-4 py-3 text-right font-mono text-gray-600 dark:text-gray-400">{row.buyLot}</td>
                      <td className="px-4 py-3 text-right font-mono text-red-600 dark:text-red-400">{row.sellVal}</td>
                      <td className="px-4 py-3 text-right font-mono text-gray-600 dark:text-gray-400">{row.sellLot}</td>
                      <td className={`px-4 py-3 text-right font-mono font-bold ${row.rawNetVal >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                        {row.rawNetVal >= 0 ? '+' : '-'}{row.netVal}
                      </td>
                      {meta?.mode === 'range' && <td className="px-4 py-3 text-center text-gray-500 dark:text-gray-400">{row.daysActive || 1}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="p-12 text-center">
              <Search className="w-10 h-10 text-gray-300 dark:text-gray-600 mx-auto mb-3" />
              <p className="text-gray-500 dark:text-gray-400">Tidak ada data untuk broker {brokerCode}</p>
            </div>
          )}
        </div>
      )}

      {/* Empty State */}
      {!data && !loading && (
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-12 text-center">
          <Eye className="w-12 h-12 text-gray-300 dark:text-gray-600 mx-auto mb-4" />
          <h3 className="text-lg font-semibold text-gray-700 dark:text-gray-300 mb-1">Broker Stalker</h3>
          <p className="text-sm text-gray-500 dark:text-gray-400 max-w-md mx-auto">
            Masukkan kode broker (2 huruf) dan klik Run untuk melihat semua saham yang ditransaksikan.
            Gunakan mode Akumulasi untuk melihat total buy/sell dalam rentang waktu.
          </p>
        </div>
      )}
    </div>
  );
}
