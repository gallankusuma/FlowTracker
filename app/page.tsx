"use client";
import Navbar from "@/components/Navbar";
import MacroPanel from "@/components/MacroPanel";
import { API_BASE } from "@/lib/apiConfig";
import { useState, useEffect } from "react";

const FAQ = [
  { q: "Apa itu FlowTracker?", a: "FlowTracker adalah platform bandarmologi berbasis data yang membantu investor IDX melacak pergerakan smart money, akumulasi broker besar, dan insider moves secara real-time." },
  { q: "Bagaimana cara kerja Flow Analyzer?", a: "Flow Analyzer menganalisis konsentrasi top 3 broker pada setiap saham selama 5 hari terakhir untuk mengidentifikasi pola akumulasi atau distribusi oleh pelaku pasar besar." },
  { q: "Apakah data diupdate setiap hari?", a: "Ya, data diupdate setiap hari setelah sesi bursa tutup (biasanya pukul 16:30 WIB) berdasarkan data resmi dari IDX dan KSEI." },
  { q: "Apakah FlowTracker bisa diakses via HP?", a: "Ya, FlowTracker didesain responsif dan dapat diakses melalui browser di smartphone, tablet, maupun desktop." },
  { q: "Apakah FlowTracker cocok untuk pemula?", a: "Sangat cocok! Kami menyediakan panduan penggunaan dan video tutorial untuk membantu pemula memahami konsep bandarmologi dengan mudah." },
  { q: "Apa perbedaan Flow Analyzer dengan Accumulation Streak?", a: "Flow Analyzer menampilkan snapshot harian konsentrasi broker, sedangkan Accumulation Streak mendeteksi pola pembelian konsisten oleh broker yang sama selama 2-5 hari berturut-turut." },
  { q: "Dapatkah saya memantau broker spesifik?", a: "Ya! Fitur Broker Activity memungkinkan Anda untuk 'stalking' broker tertentu dan melihat saham apa saja yang sedang mereka akumulasi atau distribusi." },
  { q: "Bagaimana cara berlangganan?", a: "Klik tombol 'Daftar Sekarang' untuk mendaftar akun Member. Paket membership memberikan akses penuh ke semua data dan fitur analisis." },
];

type Signal = { ticker: string; price: number; change: number; signal: string };
type Stats = { activeBrokers: number; trackedStocks: number; latestDate: string; totalRecords: number };

function SignalBadge({ signal }: { signal: string }) {
  const colors: Record<string, { bg: string; text: string; border: string }> = {
    ACCUMULATION: { bg: "rgba(63,185,80,0.12)", text: "#3fb950", border: "rgba(63,185,80,0.3)" },
    DISTRIBUTION:  { bg: "rgba(248,81,73,0.12)", text: "#f85149", border: "rgba(248,81,73,0.3)" },
    NEUTRAL:       { bg: "rgba(139,148,158,0.12)", text: "#8b949e", border: "rgba(139,148,158,0.3)" },
  };
  const c = colors[signal] || colors.NEUTRAL;
  return (
    <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.08em",
      padding: "2px 7px", borderRadius: 4,
      background: c.bg, color: c.text, border: `1px solid ${c.border}` }}>
      {signal}
    </span>
  );
}

export default function Dashboard() {
  const [signals, setSignals] = useState<Signal[]>([]);
  const [stats, setStats] = useState<Stats>({ activeBrokers: 0, trackedStocks: 0, latestDate: "", totalRecords: 0 });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${API_BASE}/api/dashboard-summary`)
      .then(r => r.json())
      .then(json => {
        setSignals(json.signals || []);
        setStats(json.stats || {});
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <>
      <Navbar />
      <main style={{ maxWidth: 1400, margin: "0 auto", padding: "32px 24px" }}>

        {/* Welcome banner */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 24, marginBottom: 32 }}
          className="dashboard-grid">
          <div>
            <p style={{ color: "var(--text-muted)", fontSize: 14, marginBottom: 4 }}>Welcome back,</p>
            <h1 style={{ fontSize: 32, fontWeight: 900, color: "var(--text-primary)",
              fontFamily: "'Space Grotesk', sans-serif", margin: "0 0 16px" }}>
              GALLAN! 👋
            </h1>

            {/* Live stats */}
            <div className="card" style={{ padding: 16, marginBottom: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", letterSpacing: "0.1em", marginBottom: 12 }}>
                📊 PLATFORM STATS
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                {[
                  { label: "Active Brokers", value: stats.activeBrokers, icon: "🏦" },
                  { label: "Tracked Stocks", value: stats.trackedStocks, icon: "📈" },
                  { label: "Total Records", value: stats.totalRecords, icon: "💾" },
                  { label: "Latest Data", value: stats.latestDate ? new Date(stats.latestDate).toLocaleDateString("id-ID") : "—", icon: "📅" },
                ].map(s => (
                  <div key={s.label} style={{ padding: "8px 10px", borderRadius: 8,
                    background: "var(--bg-primary)", border: "1px solid var(--border)" }}>
                    <div style={{ fontSize: 10, color: "var(--text-muted)" }}>{s.icon} {s.label}</div>
                    <div style={{ fontSize: 16, fontWeight: 800, color: "var(--text-primary)",
                      fontFamily: "'Space Grotesk', sans-serif" }}>{s.value}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Feature icons */}
            <div>
              <p style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)",
                letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 12 }}>
                FITUR FLOWTRACKER
              </p>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                {[
                  { icon: "📊", label: "FLOW\nANALYZER", href: "/flow-analyzer" },
                  { icon: "🔍", label: "INSIDER\nMOVES", href: "/insider-moves" },
                  { icon: "📈", label: "ACCUMULATION\nSTREAK", href: "/accumulation-streak" },
                  { icon: "🤝", label: "BROKER\nACTIVITY", href: "/broker-activity" },
                  { icon: "🌐", label: "MARKET\nOVERVIEW", href: "/market-overview" },
                ].map(f => (
                  <a key={f.label} href={f.href} style={{ textDecoration: "none" }}>
                    <div className="card card-hover" style={{ padding: "14px", textAlign: "center", cursor: "pointer" }}>
                      <div style={{ fontSize: 20, marginBottom: 6 }}>{f.icon}</div>
                      <div style={{ fontSize: 10, fontWeight: 700, color: "var(--text-secondary)",
                        letterSpacing: "0.06em", lineHeight: 1.4, whiteSpace: "pre-line" }}>{f.label}</div>
                    </div>
                  </a>
                ))}
              </div>
            </div>
          </div>

          {/* Right column */}
          <div>
            {/* Live Market Signals */}
            <div className="card" style={{ padding: 20, marginBottom: 20 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
                <h2 style={{ fontSize: 12, fontWeight: 700, color: "var(--text-muted)", letterSpacing: "0.1em",
                  textTransform: "uppercase", margin: 0 }}>⚡ Live Market Signals</h2>
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                  {loading ? "Loading..." : `${signals.length} signals`}
                </span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
                {(signals.length > 0 ? signals : [
                  { ticker: "—", price: 0, change: 0, signal: "NEUTRAL" },
                ]).slice(0, 6).map((t, i) => (
                  <div key={`${t.ticker}-${i}`} className="card" style={{ padding: "12px", background: "var(--bg-primary)" }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                      <span style={{ fontSize: 15, fontWeight: 800, color: "var(--text-primary)",
                        fontFamily: "'Space Grotesk', sans-serif" }}>{t.ticker}</span>
                      <SignalBadge signal={t.signal} />
                    </div>
                    <div style={{ fontSize: 17, fontWeight: 700, color: "var(--text-primary)", marginBottom: 2 }}>
                      {t.price > 0 ? `Rp ${t.price.toLocaleString("id-ID")}` : "—"}
                    </div>
                    <div style={{ fontSize: 12, fontWeight: 600,
                      color: t.change > 0 ? "var(--accent-green)" : t.change < 0 ? "var(--accent-red)" : "var(--text-muted)" }}>
                      {t.change > 0 ? "+" : ""}{t.change.toFixed(2)}%
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Market context. Placed under the signals and above the FAQ
                because it describes the weather, not the trade. */}
            <MacroPanel />

            {/* FAQ */}
            <div className="card" style={{ padding: 20 }}>
              <h2 style={{ fontSize: 12, fontWeight: 700, color: "var(--text-muted)",
                letterSpacing: "0.1em", textTransform: "uppercase", margin: "0 0 16px" }}>
                ❓ FREQUENTLY ASKED QUESTIONS
              </h2>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                {FAQ.map((item, i) => (
                  <details key={i} style={{ background: "var(--bg-primary)", borderRadius: 8,
                    border: "1px solid var(--border)", padding: "12px 14px", cursor: "pointer" }}>
                    <summary style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)",
                      listStyle: "none", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      {item.q}
                      <span style={{ color: "var(--text-muted)", fontSize: 14, flexShrink: 0, marginLeft: 8 }}>▾</span>
                    </summary>
                    <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 10, lineHeight: 1.6 }}>{item.a}</p>
                  </details>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Disclaimer */}
        <div className="card" style={{ padding: 24, borderColor: "rgba(210,153,34,0.3)", background: "rgba(210,153,34,0.04)" }}>
          <h3 style={{ fontSize: 14, fontWeight: 800, color: "var(--accent-yellow)",
            letterSpacing: "0.1em", margin: "0 0 16px", textTransform: "uppercase" }}>⚠️ DISCLAIMER</h3>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            {[
              { title: "Informasi Bukan Nasihat Keuangan", desc: "Seluruh data yang disajikan murni bersifat informatif. FlowTracker tidak memberikan rekomendasi beli atau jual saham tertentu." },
              { title: "Risiko Pasar Modal", desc: "Investasi saham memiliki risiko fluktuasi harga yang tinggi. Pengguna disarankan untuk melakukan analisis mandiri (DYOR)." },
              { title: "Akurasi Data", desc: "FlowTracker berupaya menyajikan data yang paling akurat dari sumber bursa resmi. Namun, kami tidak bertanggung jawab atas keterlambatan data." },
              { title: "Batasan Tanggung Jawab", desc: "FlowTracker tidak bertanggung jawab atas kerugian finansial yang timbul dari penggunaan data di dalam platform ini." },
            ].map(d => (
              <div key={d.title} style={{ display: "flex", gap: 10 }}>
                <div style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--accent-yellow)", flexShrink: 0, marginTop: 5 }}></div>
                <div>
                  <p style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)", margin: "0 0 4px" }}>{d.title}</p>
                  <p style={{ fontSize: 12, color: "var(--text-muted)", margin: 0, lineHeight: 1.6 }}>{d.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </main>

      <style>{`@media (max-width: 900px) { .dashboard-grid { grid-template-columns: 1fr !important; } }`}</style>
    </>
  );
}
