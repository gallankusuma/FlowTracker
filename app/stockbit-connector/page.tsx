"use client";
import Navbar from "@/components/Navbar";
import { API_BASE } from "@/lib/apiConfig";
import { useState, useEffect } from "react";

type StockStatus = {
  stock_code: string;
  days_count: number;
  latest_date: string;
  broker_rows: number;
};

// ── Minified bookmarklet code ──────────────────────────────────────────────────
const BOOKMARKLET_CODE = `javascript:(function(){
const VPS='http://76.13.22.155:3100/api/stockbit-import';
/* ── Remove old panel ── */
const old=document.getElementById('sb-h5');if(old)old.remove();
const panel=document.createElement('div');
panel.id='sb-h5';
panel.style.cssText='position:fixed;top:16px;right:16px;z-index:999999;background:#0d1117;border:1px solid #21262d;border-radius:12px;padding:16px;width:420px;font-family:monospace;font-size:11px;box-shadow:0 16px 48px rgba(0,0,0,.9);color:#e6edf3;';
panel.innerHTML='<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;"><span style="font-weight:700;color:#58a6ff;font-size:13px;">📡 Stockbit Harvester v5</span><button id="shx5" style="background:none;border:none;color:#6e7681;cursor:pointer;font-size:16px;padding:0;">✕</button></div>'
+'<div id="shl5" style="background:#010409;border-radius:8px;padding:10px;max-height:200px;overflow-y:auto;line-height:1.8;"></div>'
+'<div style="margin-top:10px;background:#0d2117;border:1px solid #1a4731;border-radius:8px;padding:10px;font-size:10px;">'
+'<div style="color:#3fb950;font-weight:700;margin-bottom:4px;">📌 CARA PAKAI — MODE PASIF (PALING MUDAH):</div>'
+'<div style="color:#8b949e;line-height:1.8;">1. Panel ini sudah aktif (spy mode ON)<br>2. Di Stockbit, buka halaman broker saham<br>   contoh: klik tab "Broker Summary" di BBCA<br>3. Data otomatis ter-capture & kirim ke VPS!<br>4. Lihat log hijau ✅ di atas</div>'
+'</div>'
+'<div style="margin-top:10px;display:flex;gap:8px;">'
+'<button id="shn5" style="flex:1;background:#238636;border:none;border-radius:6px;padding:8px;color:#fff;cursor:pointer;font-size:11px;font-weight:700;">⬇ Fetch Current</button>'
+'<button id="sha5" style="flex:1;background:#1f6feb;border:none;border-radius:6px;padding:8px;color:#fff;cursor:pointer;font-size:11px;font-weight:700;">⬇ Fetch Top 40</button>'
+'</div>'
+'<div id="shprog5" style="margin-top:8px;font-size:10px;color:#3fb950;text-align:center;display:none;"></div>';
document.body.appendChild(panel);
document.getElementById('shx5').onclick=()=>panel.remove();
const L=document.getElementById('shl5');
const PROG=document.getElementById('shprog5');
function log(m,c='#8b949e'){L.innerHTML+='<span style="color:'+c+';">'+m+'</span><br>';L.scrollTop=L.scrollHeight;}
function prog(m){PROG.style.display='block';PROG.textContent=m;}

/* ══════════════════════════════════════════════════
   STEP 1: Intercept XHR to capture Authorization header
   from Stockbit's own requests (most reliable method)
   ══════════════════════════════════════════════════ */
let AUTH_TOKEN = null;

const _open = XMLHttpRequest.prototype.open;
const _setHeader = XMLHttpRequest.prototype.setRequestHeader;
const _send = XMLHttpRequest.prototype.send;

XMLHttpRequest.prototype.open = function(method, url) {
  this._xhrUrl = String(url || '');
  this._xhrMethod = method;
  return _open.apply(this, arguments);
};

XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
  if (this._xhrUrl && this._xhrUrl.includes('exodus.stockbit') && 
      name.toLowerCase() === 'authorization' && value && value.length > 20) {
    if (!AUTH_TOKEN) {
      AUTH_TOKEN = value; // e.g. "Bearer eyJhbGci..."
      log('🔑 Token captured! len='+value.length,'#3fb950');
      log('  Ready to fetch broker data','#3fb950');
    }
  }
  return _setHeader.apply(this, arguments);
};

/* ══════════════════════════════════════════════════
   STEP 2: Intercept fetch() to ALSO capture token
   AND to auto-capture broker data passively
   ══════════════════════════════════════════════════ */
const _fetch = window.fetch;
window.fetch = async function(...args) {
  const url = String(args[0]?.url || args[0] || '');
  const opts = args[1] || {};
  
  // Capture token from outgoing fetch headers
  if (url.includes('exodus.stockbit') && !AUTH_TOKEN) {
    const h = opts.headers || {};
    const auth = h['Authorization'] || h['authorization'];
    if (auth && auth.length > 20) {
      AUTH_TOKEN = auth;
      log('🔑 Token captured via fetch! len='+auth.length,'#3fb950');
    }
  }
  
  const res = await _fetch.apply(this, args);
  
  // Auto-capture broker data passively
  if (url.includes('exodus.stockbit') && 
      (url.includes('broker') || url.includes('top?sort=TB') || url.includes('transaction_type'))) {
    const cl = res.clone();
    try {
      const d = await cl.json();
      const bk = parseBrokers(d);
      const tm = url.match(/emitent=([A-Z0-9]+)/i) || 
                 url.match(/symbol=([A-Z0-9]+)/i) ||
                 url.match(/\/([A-Z]{2,8})\?/);
      if (bk && bk.length > 0 && tm) {
        const ticker = tm[1].toUpperCase();
        const today = new Date().toISOString().split('T')[0];
        log('🎯 Auto-captured '+bk.length+' brokers for '+ticker,'#3fb950');
        sendVPS(ticker, d.date || today, bk);
      }
    } catch(e) {}
  }
  
  return res;
};

/* ── Parse broker array ── */
function parseBrokers(raw) {
  if (!raw) return null;
  if (raw.data?.broker && Array.isArray(raw.data.broker)) return raw.data.broker;
  if (raw.data?.data && Array.isArray(raw.data.data)) return raw.data.data;
  if (Array.isArray(raw.data)) return raw.data;
  if (Array.isArray(raw)) return raw;
  if (raw.brokers) return raw.brokers;
  // Recursive search for array with broker-like objects
  function dig(obj, depth) {
    if (depth > 5 || !obj || typeof obj !== 'object') return null;
    for (const k of Object.keys(obj)) {
      if (Array.isArray(obj[k]) && obj[k].length > 0) {
        const item = obj[k][0];
        if (item && (item.code || item.broker_code || item.Code || item.BrokerID || item.broker_id)) {
          return obj[k];
        }
      }
      const found = dig(obj[k], depth + 1);
      if (found) return found;
    }
    return null;
  }
  return dig(raw, 0);
}

/* ── Normalize broker ── */
function normBroker(b) {
  return {
    code: b.code || b.broker_code || b.Code || b.BrokerID || b.broker_id || '',
    name: b.name || b.broker_name || b.Name || b.BrokerName || b.companyName || '',
    total_val: +(b.totalVal || b.total_val || b.TVal || b.TotalValue || 0),
    net_val: +(b.netVal || b.net_val || b.NVal || b.NetValue || b.net || 0),
    buy_val: +(b.buyVal || b.buy_val || b.BVal || b.BuyValue || b.buy || 0),
    sell_val: +(b.sellVal || b.sell_val || b.SVal || b.SellValue || b.sell || 0),
  };
}

/* ── Send to VPS ── */
async function sendVPS(ticker, date, brokers) {
  const rows = brokers.map(normBroker).filter(b => b.code);
  if (rows.length === 0) { log('  ⚠️ no valid broker rows','#e3b341'); return; }
  log('📤 '+rows.length+' → VPS ['+ticker+' '+date+']','#e3b341');
  try {
    const r = await _fetch(VPS, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({date, stock_code: ticker, brokers: rows, board: 'RG', source: 'stockbit'})
    });
    const j = await r.json();
    if (j.ok) {
      log('✅ '+j.inserted+' inserted, '+j.skipped+' skipped','#3fb950');
    } else {
      log('❌ VPS: '+(j.error || JSON.stringify(j)),'#f85149');
    }
  } catch(e) {
    log('❌ VPS error: '+e.message,'#f85149');
  }
}

/* ── Manual fetch with captured token ── */
async function fetchWithToken(url) {
  if (!AUTH_TOKEN) {
    log('⚠️ Token belum ada. Browse ke halaman broker Stockbit dulu!','#e3b341');
    return null;
  }
  try {
    const r = await _fetch(url, {
      headers: {'Authorization': AUTH_TOKEN, 'Accept': 'application/json'}
    });
    log('  HTTP '+r.status+(r.status===200?' ✓':' ✗'),'#8b949e');
    if (r.status === 200) return await r.json();
  } catch(e) {
    log('  ❌ '+e.message,'#f85149');
  }
  return null;
}

async function harvestTicker(ticker) {
  log('\n━━ '+ticker,'#58a6ff');
  const today = new Date().toISOString().split('T')[0];
  const urls = [
    'https://exodus.stockbit.com/order-trade/broker/activity?emitent='+ticker+'&market=RG',
    'https://exodus.stockbit.com/order-trade/broker/summary?emitent='+ticker+'&market=RG',
    'https://exodus.stockbit.com/top?sort=TB_SORT_BY_TOTAL_VALUE&order=ORDER_BY_DESC&limit=50&emitent='+ticker+'&market=RG',
  ];
  for (const url of urls) {
    log(' 🔌 '+url.split('?')[0].split('/').slice(-2).join('/'),'#8b949e');
    const d = await fetchWithToken(url);
    if (!d) continue;
    const bk = parseBrokers(d);
    if (bk && bk.length > 0) {
      log('  ✅ '+bk.length+' brokers','#3fb950');
      await sendVPS(ticker, d.date || today, bk);
      return true;
    }
    log('  no broker array','#e3b341');
  }
  return false;
}

/* ── Buttons ── */
const TOP = ['BBCA','BBRI','BMRI','BBNI','TLKM','ASII','GOTO','BREN','BRPT','TPIA',
  'PGAS','MTEL','ICBP','UNVR','GGRM','HMSP','SMGR','INDF','KLBF','ANTM',
  'INCO','PTBA','ADRO','ITMG','BUMI','EXCL','ISAT','MEDC','ELSA','MDKA',
  'CPIN','JPFA','MAIN','TBLA','SIMP','AALI','SGRO','PALM','LSIP','SSMS'];

function getTicker() {
  const m = location.href.match(/\/stock[s]?\/([A-Z0-9]{2,8})/i);
  return m ? m[1].toUpperCase() : null;
}

document.getElementById('shn5').onclick = async () => {
  const t = getTicker();
  if (!t) { log('❌ Buka: stockbit.com/#/stock/BBCA','#f85149'); return; }
  await harvestTicker(t);
};

document.getElementById('sha5').onclick = async () => {
  if (!AUTH_TOKEN) {
    log('⚠️ Browse ke halaman broker Stockbit dulu untuk capture token!','#e3b341');
    return;
  }
  log('🚀 Harvesting '+TOP.length+' stocks...','#58a6ff');
  let ok = 0, fail = 0;
  for (let i = 0; i < TOP.length; i++) {
    prog('['+(i+1)+'/'+TOP.length+'] '+TOP[i]+'...');
    const r = await harvestTicker(TOP[i]);
    r ? ok++ : fail++;
    await new Promise(r => setTimeout(r, 1200));
  }
  prog('✅ Done: '+ok+' ok, '+fail+' fail');
  log('🏁 '+ok+' berhasil, '+fail+' gagal','#3fb950');
};

/* ── Init ── */
log('✅ Spy mode aktif (XHR + fetch)','#3fb950');
log('👉 Browse ke halaman broker Stockbit → data auto-capture','#e3b341');
const t = getTicker();
if (t) log('📌 Detected: '+t,'#e3b341');
})();`;

export default function StockbitConnector() {
  const [copied, setCopied]   = useState(false);
  const [status, setStatus]   = useState<StockStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [testResult, setTestResult] = useState<string>("");

  useEffect(() => {
    fetch(`${API_BASE}/api/stockbit-status`)
      .then(r => r.json())
      .then(j => { setStatus(j.stocks || []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  function copyBookmarklet() {
    // Fallback for HTTP (clipboard API requires HTTPS)
    try {
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(BOOKMARKLET_CODE).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2500);
        }).catch(() => fallbackCopy());
      } else {
        fallbackCopy();
      }
    } catch(e) {
      fallbackCopy();
    }
  }

  function fallbackCopy() {
    // Create temp textarea, select all, execCommand copy
    const ta = document.createElement('textarea');
    ta.value = BOOKMARKLET_CODE;
    ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try {
      const ok = document.execCommand('copy');
      if (ok) {
        setCopied(true);
        setTimeout(() => setCopied(false), 2500);
      }
    } catch(e) {}
    document.body.removeChild(ta);
  }

  function selectAllCode() {
    const el = document.getElementById('bookmarklet-code-area');
    if (!el) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    if (sel) { sel.removeAllRanges(); sel.addRange(range); }
  }

  async function testEndpoint() {
    setTestResult("Testing...");
    try {
      const r = await fetch(`${API_BASE}/api/stockbit-status`);
      const j = await r.json();
      setTestResult(`✅ VPS OK — ${j.total_stocks} stocks stored`);
    } catch(e) {
      setTestResult("❌ VPS not reachable");
    }
  }

  const card: React.CSSProperties = {
    background: "#161b22", border: "1px solid #30363d", borderRadius: 12,
    padding: "20px 24px", marginBottom: 20,
  };

  const step: React.CSSProperties = {
    display: "flex", gap: 16, alignItems: "flex-start", marginBottom: 16,
  };

  const stepNum: React.CSSProperties = {
    minWidth: 32, height: 32, borderRadius: "50%",
    background: "#1f6feb", color: "white",
    display: "flex", alignItems: "center", justifyContent: "center",
    fontWeight: 800, fontSize: 14, flexShrink: 0,
  };

  return (
    <div style={{ minHeight: "100vh", background: "#0d1117", color: "#e6edf3", fontFamily: "'Inter', sans-serif" }}>
      <Navbar />
      <div style={{ maxWidth: 900, margin: "0 auto", padding: "32px 20px" }}>

        {/* Header */}
        <div style={{ marginBottom: 32 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
            <span style={{ fontSize: 32 }}>📡</span>
            <h1 style={{ margin: 0, fontSize: 28, fontWeight: 800, color: "#58a6ff" }}>Stockbit Connector</h1>
            <span style={{ background: "#238636", color: "white", borderRadius: 6, padding: "2px 10px", fontSize: 12, fontWeight: 700 }}>BETA</span>
          </div>
          <p style={{ color: "#8b949e", margin: 0, fontSize: 14 }}>
            Import data Regular Board dari Stockbit menggunakan session browser kamu. 
            Akurasi 100% karena pakai sumber yang sama dengan FT.id.
          </p>
        </div>

        {/* Status Cards */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16, marginBottom: 24 }}>
          {[
            { label: "Stocks Imported", value: loading ? "..." : status.length, color: "#3fb950", icon: "📊" },
            { label: "Data Source", value: "Regular Board", color: "#58a6ff", icon: "🏛️" },
            { label: "Board Type", value: "RG Only", color: "#e3b341", icon: "✅" },
          ].map((s, i) => (
            <div key={i} style={{ background: "#161b22", border: "1px solid #30363d", borderRadius: 10, padding: "16px 20px" }}>
              <div style={{ fontSize: 22, marginBottom: 6 }}>{s.icon}</div>
              <div style={{ fontSize: 24, fontWeight: 800, color: s.color }}>{s.value}</div>
              <div style={{ fontSize: 12, color: "#8b949e" }}>{s.label}</div>
            </div>
          ))}
        </div>

        {/* How it Works */}
        <div style={card}>
          <h2 style={{ margin: "0 0 20px", fontSize: 18, color: "#e6edf3" }}>⚡ Cara Kerja</h2>
          {[
            { title: "Buka Stockbit di browser", desc: "Login ke akun Stockbit kamu. Buka halaman saham apapun (misal: BBCA)." },
            { title: "Buka Console (F12)", desc: "Tekan F12 → tab Console. Atau klik kanan → Inspect → Console." },
            { title: "Copy & Paste Bookmarklet", desc: "Copy kode di bawah, paste ke console, tekan Enter. Panel harvester akan muncul." },
            { title: "Klik 'Harvest'", desc: "Klik 'Current Stock' untuk 1 saham, atau 'Top 40' untuk semua saham sekaligus." },
          ].map((s, i) => (
            <div key={i} style={step}>
              <div style={stepNum}>{i + 1}</div>
              <div>
                <div style={{ fontWeight: 700, marginBottom: 4 }}>{s.title}</div>
                <div style={{ color: "#8b949e", fontSize: 13 }}>{s.desc}</div>
              </div>
            </div>
          ))}
        </div>

        {/* Bookmarklet */}
        <div style={card}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <h2 style={{ margin: 0, fontSize: 18, color: "#e6edf3" }}>📋 Bookmarklet Code</h2>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={testEndpoint} style={{
                background: "#21262d", border: "1px solid #30363d", borderRadius: 6,
                padding: "6px 14px", color: "#8b949e", cursor: "pointer", fontSize: 12,
              }}>🔌 Test VPS</button>
              <button onClick={copyBookmarklet} style={{
                background: copied ? "#238636" : "#1f6feb", border: "none", borderRadius: 6,
                padding: "6px 14px", color: "white", cursor: "pointer", fontSize: 12, fontWeight: 700,
                transition: "background 0.2s",
              }}>
                {copied ? "✅ Copied!" : "📋 Copy Code"}
              </button>
            </div>
          </div>
          {testResult && (
            <div style={{ background: "#0d1117", border: "1px solid #30363d", borderRadius: 6, padding: "8px 12px", marginBottom: 12, fontSize: 13, color: testResult.startsWith("✅") ? "#3fb950" : "#f85149" }}>
              {testResult}
            </div>
          )}
          <div
            id="bookmarklet-code-area"
            onClick={selectAllCode}
            title="Klik untuk select semua kode"
            style={{
              background: "#0d1117", border: "1px solid #30363d", borderRadius: 8,
              padding: 16, maxHeight: 120, overflowY: "auto",
              fontFamily: "monospace", fontSize: 11, color: "#e3b341",
              wordBreak: "break-all", lineHeight: 1.5,
              cursor: "pointer", userSelect: "all",
            }}>
            {BOOKMARKLET_CODE}
          </div>
          <div style={{ marginTop: 6, fontSize: 11, color: "#484f58", textAlign: "center" }}>
            💡 Klik kotak kode di atas untuk select semua → Ctrl+C untuk copy manual
          </div>
          <div style={{ marginTop: 10, fontSize: 12, color: "#8b949e" }}>
            💡 Paste ke <strong style={{ color: "#e6edf3" }}>Browser Console</strong> (F12) saat ada di halaman Stockbit.
            Script akan berjalan di konteks browser kamu (bukan server), 
            sehingga bisa akses session Stockbit dan bypass Cloudflare.
          </div>
        </div>

        {/* Imported Stocks Table */}
        {status.length > 0 && (
          <div style={card}>
            <h2 style={{ margin: "0 0 16px", fontSize: 18, color: "#e6edf3" }}>
              📊 Data Tersimpan ({status.length} stocks)
            </h2>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid #30363d" }}>
                    {["Stock", "Days", "Brokers Rows", "Latest Date"].map(h => (
                      <th key={h} style={{ padding: "8px 12px", textAlign: "left", color: "#8b949e", fontWeight: 600 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {status.map(s => (
                    <tr key={s.stock_code} style={{ borderBottom: "1px solid #21262d" }}>
                      <td style={{ padding: "8px 12px", fontWeight: 700, color: "#58a6ff" }}>{s.stock_code}</td>
                      <td style={{ padding: "8px 12px", color: "#3fb950" }}>{s.days_count}d</td>
                      <td style={{ padding: "8px 12px", color: "#e6edf3" }}>{Number(s.broker_rows).toLocaleString()}</td>
                      <td style={{ padding: "8px 12px", color: "#8b949e" }}>{s.latest_date?.toString().split('T')[0]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Why This Works */}
        <div style={{ ...card, background: "#0d1117", border: "1px solid #1f6feb33" }}>
          <h3 style={{ margin: "0 0 12px", fontSize: 15, color: "#58a6ff" }}>🔬 Kenapa pendekatan ini?</h3>
          <div style={{ fontSize: 13, color: "#8b949e", lineHeight: 1.8 }}>
            <p>Stockbit menggunakan <strong style={{ color: "#e6edf3" }}>AWS CloudFront</strong> yang memblokir semua request dari server/datacenter.
            Tapi dari browser kamu yang sudah login, request bisa lewat karena menggunakan session cookies yang valid.</p>
            <p>Ini adalah teknik yang sama dengan yang digunakan <strong style={{ color: "#e6edf3" }}>FT.id</strong> — mereka minta browser user untuk fetch data dari Stockbit,
            lalu kirim ke server mereka via <code style={{ color: "#e3b341" }}>/api/broker-streak/import-stockbit</code>.</p>
            <p style={{ margin: 0 }}>Data yang diimport adalah <strong style={{ color: "#3fb950" }}>Regular Board only</strong> (sama persis dengan yang Stockbit tampilkan)
            — tidak ada Negotiation Board yang inflate angka.</p>
          </div>
        </div>

      </div>
    </div>
  );
}
