"use client";
import { API_BASE } from "@/lib/apiConfig";
import { useState } from "react";

export default function SectorsApiPanel() {
  const [apiKey, setApiKey] = useState("");
  const [configStatus, setConfigStatus] = useState<any>(null);
  const [pullResult, setPullResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [stockCode, setStockCode] = useState("BBCA");
  const [pullMode, setPullMode] = useState<"company"|"custom">("company");
  const [customEndpoint, setCustomEndpoint] = useState("companies/");

  const saveApiKey = async () => {
    if (!apiKey.trim()) return;
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/sectors/configure`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: apiKey }),
      });
      const json = await res.json();
      setConfigStatus(json);
    } catch (err: any) {
      setConfigStatus({ success: false, error: err.message });
    }
    setLoading(false);
  };

  const pullData = async () => {
    setLoading(true);
    setPullResult(null);
    try {
      const endpoint = pullMode === "company" ? "sectors/pull-broker" : "sectors/pull";
      const body = pullMode === "company"
        ? { stock_code: stockCode.toUpperCase() }
        : { endpoint: customEndpoint };
      const res = await fetch(`${API_BASE}/api/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      setPullResult(json);
    } catch (err: any) {
      setPullResult({ success: false, error: err.message });
    }
    setLoading(false);
  };

  const cardStyle: React.CSSProperties = {
    padding: 20, borderRadius: 12,
    background: "var(--bg-secondary)", border: "1px solid var(--border)", marginBottom: 16,
  };
  const labelStyle: React.CSSProperties = {
    fontSize: 11, color: "var(--text-muted)", letterSpacing: "0.08em",
    display: "block", marginBottom: 6,
  };

  return (
    <div>
      {/* Setup Card */}
      <div style={cardStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
          <span style={{ fontSize: 20 }}>🔑</span>
          <h3 style={{ margin: 0, fontSize: 14, fontWeight: 800, color: "var(--text-primary)", letterSpacing: "0.04em" }}>
            SECTORS.APP API KEY
          </h3>
        </div>
        <p style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6, margin: "0 0 14px" }}>
          Sign up di <a href="https://sectors.app" target="_blank" rel="noopener"
            style={{ color: "var(--accent-cyan)", textDecoration: "underline" }}>sectors.app</a> (free 100 req/hari),
          lalu paste API key di bawah.
        </p>
        <label style={labelStyle}>API KEY</label>
        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
          <input className="ft-input" value={apiKey} onChange={e => setApiKey(e.target.value)}
            placeholder="Paste Sectors.app API key..."
            type="password"
            style={{ flex: 1, fontSize: 13, fontFamily: "monospace" }} />
          <button onClick={saveApiKey} disabled={loading}
            style={{ padding: "8px 20px", borderRadius: 8, fontWeight: 800, fontSize: 12,
              background: "linear-gradient(135deg, #d29922, #f0b429)", color: "#000",
              border: "none", cursor: "pointer", letterSpacing: "0.06em", whiteSpace: "nowrap" }}>
            {loading ? "⏳" : "💾 SAVE KEY"}
          </button>
        </div>
        {configStatus && (
          <div style={{ padding: "8px 12px", borderRadius: 8, fontSize: 12, marginTop: 8,
            background: configStatus.success ? "rgba(63,185,80,0.1)" : "rgba(248,81,73,0.1)",
            border: `1px solid ${configStatus.success ? "rgba(63,185,80,0.3)" : "rgba(248,81,73,0.3)"}`,
            color: configStatus.success ? "var(--accent-green)" : "var(--accent-red)" }}>
            {configStatus.success ? "✅ API Key saved!" : `❌ ${configStatus.error}`}
          </div>
        )}
      </div>

      {/* Pull Data Card */}
      <div style={cardStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
          <span style={{ fontSize: 20 }}>📡</span>
          <h3 style={{ margin: 0, fontSize: 14, fontWeight: 800, color: "var(--text-primary)" }}>PULL DATA</h3>
        </div>
        <div style={{ display: "flex", gap: 4, marginBottom: 14 }}>
          {(["company", "custom"] as const).map(m => (
            <button key={m} onClick={() => setPullMode(m)}
              style={{ padding: "6px 14px", borderRadius: 20, fontSize: 11, fontWeight: 700,
                background: pullMode === m ? "var(--accent-blue)" : "transparent",
                color: pullMode === m ? "#fff" : "var(--text-muted)",
                border: `1px solid ${pullMode === m ? "var(--accent-blue)" : "var(--border)"}`,
                cursor: "pointer" }}>
              {m === "company" ? "🏢 COMPANY" : "🔧 CUSTOM"}
            </button>
          ))}
        </div>

        {pullMode === "company" ? (
          <div>
            <label style={labelStyle}>STOCK CODE (IDX)</label>
            <div style={{ display: "flex", gap: 8 }}>
              <input className="ft-input" value={stockCode}
                onChange={e => setStockCode(e.target.value.toUpperCase())}
                placeholder="e.g. BBCA"
                style={{ width: 120, fontSize: 16, fontWeight: 800, textAlign: "center",
                  letterSpacing: "0.1em", fontFamily: "'Space Grotesk', sans-serif" }} />
              <button onClick={pullData} disabled={loading}
                style={{ padding: "8px 20px", borderRadius: 8, fontWeight: 800, fontSize: 12,
                  background: loading ? "var(--border)" : "linear-gradient(135deg, #2f81f7, #39d2f5)",
                  color: "#fff", border: "none", cursor: "pointer" }}>
                {loading ? "⏳ PULLING..." : "📡 PULL DATA"}
              </button>
            </div>
            <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
              {["BBCA","BBRI","GOTO","TLKM","ASII","BMRI","BBNI","ANTM","UNVR","ICBP"].map(t => (
                <button key={t} onClick={() => setStockCode(t)}
                  style={{ padding: "4px 10px", borderRadius: 12, fontSize: 10, fontWeight: 700,
                    background: stockCode === t ? "rgba(47,129,247,0.15)" : "transparent",
                    color: stockCode === t ? "var(--accent-blue)" : "var(--text-muted)",
                    border: `1px solid ${stockCode === t ? "var(--accent-blue)" : "var(--border)"}`,
                    cursor: "pointer" }}>{t}</button>
              ))}
            </div>
          </div>
        ) : (
          <div>
            <label style={labelStyle}>ENDPOINT PATH</label>
            <div style={{ display: "flex", gap: 8 }}>
              <span style={{ padding: "8px 0", fontSize: 12, color: "var(--text-muted)" }}>api.sectors.app/v1/</span>
              <input className="ft-input" value={customEndpoint}
                onChange={e => setCustomEndpoint(e.target.value)}
                style={{ flex: 1, fontSize: 12, fontFamily: "monospace" }} />
              <button onClick={pullData} disabled={loading}
                style={{ padding: "8px 20px", borderRadius: 8, fontWeight: 800, fontSize: 12,
                  background: loading ? "var(--border)" : "linear-gradient(135deg, #2f81f7, #39d2f5)",
                  color: "#fff", border: "none", cursor: "pointer" }}>
                {loading ? "⏳" : "📡 PULL"}
              </button>
            </div>
          </div>
        )}

        {/* Result */}
        {pullResult && (
          <div style={{ marginTop: 14, padding: 14, borderRadius: 8,
            background: pullResult.success ? "rgba(63,185,80,0.06)" : "rgba(248,81,73,0.06)",
            border: `1px solid ${pullResult.success ? "rgba(63,185,80,0.2)" : "rgba(248,81,73,0.2)"}` }}>
            <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8,
              color: pullResult.success ? "var(--accent-green)" : "var(--accent-red)" }}>
              {pullResult.success ? "✅ Data Retrieved" : `❌ ${pullResult.error}`}
              {pullResult.howto && <span style={{ display: "block", fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>{pullResult.howto}</span>}
            </div>
            {pullResult.data && (
              <pre style={{ margin: 0, fontSize: 11, color: "var(--text-secondary)",
                maxHeight: 300, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all",
                background: "var(--bg-primary)", padding: 12, borderRadius: 6 }}>
                {JSON.stringify(pullResult.data, null, 2).slice(0, 3000)}
              </pre>
            )}
          </div>
        )}
      </div>

      {/* How it works */}
      <div style={cardStyle}>
        <h3 style={{ fontSize: 12, fontWeight: 700, color: "var(--text-muted)", letterSpacing: "0.1em", margin: "0 0 12px" }}>
          📖 CARA SETUP
        </h3>
        <ol style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: "var(--text-secondary)", lineHeight: 2.2 }}>
          <li>Buka <a href="https://sectors.app" target="_blank" style={{ color: "var(--accent-cyan)" }}>sectors.app</a> → Sign Up (free)</li>
          <li>Ambil API Key dari Dashboard</li>
          <li>Paste API Key di form di atas → Save</li>
          <li>Pilih stock code → Pull Data</li>
          <li>Data otomatis masuk ke FlowTracker! ✨</li>
        </ol>
      </div>
    </div>
  );
}
