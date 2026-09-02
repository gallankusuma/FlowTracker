"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useEffect, useRef } from "react";

const NAV_ITEMS = [
  { label: "Dashboard",           href: "/",                    icon: "🏠" },
  // Second, on purpose: this is the page the day is supposed to start on, and a
  // "start here" screen buried under More is a screen nobody starts on.
  { label: "Trade Desk",          href: "/trade-desk",          icon: "🖥", badge: "LIVE", badgeColor: "#3fb950" },
  { label: "Flow Analyzer",       href: "/flow-analyzer",       icon: "🌊" },
  { label: "Accum. Streak",       href: "/accumulation-streak", icon: "🔥" },
  { label: "Broker Activity",     href: "/broker-activity",     icon: "📋" },
  { label: "Signal Scanner",      href: "/signal-scanner",      icon: "🎯", badge: "NEW" },
  { label: "Deep Analysis",       href: "/deep-analysis",       icon: "🔬", badge: "NEW", badgeColor: "#39d2f5" },
  { label: "Float Map",           href: "/float-map",           icon: "🧭", badge: "EXP", badgeColor: "#a371f7" },
  { label: "Insider Moves",       href: "/insider-moves",       icon: "👁" },
  { label: "IDX Big Caps",        href: "/idx",                 icon: "🏛", badge: "NEW", badgeColor: "#f0a500" },
  { label: "US Market",           href: "/us-signal-scanner",   icon: "🇺🇸", badge: "NEW", badgeColor: "#f0a500" },
  { label: "AWO",                  href: "/awo-dashboard",       icon: "🧠", badge: "AI", badgeColor: "#17C671" },
  { label: "Watchlist",           href: "/watchlist",           icon: "⭐" },
  { label: "Position Sizer",      href: "/position-sizer",      icon: "📐" },
  { label: "Trade Journal",       href: "/trade-journal",       icon: "📓" },
  { label: "Virtual Portfolio",   href: "/virtual-portfolio",   icon: "💼", badge: "SIM", badgeColor: "#58a6ff" },
  { label: "Stockbit",            href: "/stockbit-connector",  icon: "📡", badge: "RG", badgeColor: "#3fb950" },
  { label: "Strategy Lab",        href: "/strategy-lab",         icon: "🤖", badge: "AI", badgeColor: "#17C671" },
  { label: "Journey",              href: "/journey",              icon: "📈", badge: "NEW", badgeColor: "#f0a500" },
];

// THE RULE, because reading the history of this constant is how I walked past it
// once already: INSERTING ANYWHERE ABOVE THE CUT MEANS RAISING THE CUT, or
// deliberately choosing which item drops below it. Appending at the end needs no
// change. Adding Deep Analysis at position 8 without doing either is what pushed
// Float Map into the More menu.
//
// Back to 8 by CHOICE, not by arithmetic: the user asked for Insider Moves to be
// the one that leaves the primary bar rather than Float Map, so it now heads the
// More menu instead of sitting at the bottom of it. The page is untouched and
// still reachable at /insider-moves.
const PRIMARY_COUNT = 8;
const PRIMARY_ITEMS = NAV_ITEMS.slice(0, PRIMARY_COUNT);
const MORE_ITEMS    = NAV_ITEMS.slice(PRIMARY_COUNT);

export default function Navbar() {
  const pathname     = usePathname();
  const [theme, setTheme]         = useState<"dark"|"light">("dark");
  const [moreOpen, setMoreOpen]   = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const saved = (localStorage.getItem("ft-theme") as "dark"|"light") || "dark";
    setTheme(saved);
    document.documentElement.setAttribute("data-theme", saved);
  }, []);

  // Close More dropdown when clicking outside
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) {
        setMoreOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("ft-theme", next);
  };

  const isMoreActive = MORE_ITEMS.some(i => pathname === i.href);

  const Badge = ({ item }: { item: typeof NAV_ITEMS[0] }) => {
    if (!(item as any).badge) return null;
    const isGreen = !!(item as any).badgeColor;
    return (
      <span style={{
        fontSize: 10, fontWeight: 800, padding: "1px 5px", borderRadius: 4,
        background: isGreen ? "rgba(63,185,80,0.15)" : "rgba(47,129,247,0.15)",
        color:      isGreen ? "#3fb950"               : "#58a6ff",
        border:     `1px solid ${isGreen ? "rgba(63,185,80,0.4)" : "rgba(47,129,247,0.3)"}`,
        letterSpacing: "0.05em", lineHeight: 1,
      }}>{(item as any).badge}</span>
    );
  };

  const navLinkStyle = (isActive: boolean): React.CSSProperties => ({
    textDecoration: "none",
    display: "flex", alignItems: "center", gap: 5,
    padding: "11px 14px",
    fontSize: 14, fontWeight: isActive ? 700 : 500,
    color: isActive ? "#58a6ff" : "var(--text-secondary)",
    borderBottom: isActive ? "2px solid #58a6ff" : "2px solid transparent",
    whiteSpace: "nowrap",
    transition: "color 0.15s, border-color 0.15s",
    letterSpacing: "0.04em",
    cursor: "pointer",
  });

  return (
    <>
      <header style={{
        background: "var(--bg-secondary)",
        borderBottom: "1px solid var(--border)",
        position: "sticky", top: 0, zIndex: 200,
      }}>

        {/* ── Row 1: Logo + Controls ── */}
        <div style={{ maxWidth: "none", padding: "0 32px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", height: 58, gap: 12, minWidth: 0 }}>

            <Link href="/" style={{ textDecoration: "none", display: "flex", alignItems: "center", gap: 10, flexShrink: 0, minWidth: 0 }}>
              <div style={{
                width: 36, height: 36,
                background: "linear-gradient(135deg, #2f81f7, #39d2f5)",
                borderRadius: 7, display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 19, fontWeight: 800, color: "#fff",
                boxShadow: "0 0 14px rgba(47,129,247,0.4)"
              }}>F</div>
              <div>
                <div style={{ fontSize: 16, fontWeight: 800, color: "var(--text-primary)", letterSpacing: "0.08em" }}>FLOWTRACKER</div>
                <div style={{ fontSize: 10, color: "var(--accent-cyan)", letterSpacing: "0.15em", fontWeight: 600, marginTop: -1 }}>UNCOVER THE HIDDEN MOVES</div>
              </div>
            </Link>

            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div className="badge-live">
                <span className="pulse-dot" style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--accent-green)", display: "inline-block" }}></span>
                LIVE
              </div>
              <button onClick={toggleTheme} className="theme-toggle" title="Toggle theme">
                {theme === "dark" ? "☀️" : "🌙"}
              </button>
              <div style={{
                display: "flex", alignItems: "center", gap: 7, cursor: "pointer",
                padding: "5px 10px", borderRadius: 7, border: "1px solid var(--border)",
                fontSize: 15, color: "var(--text-secondary)"
              }}>
                <span style={{
                  width: 22, height: 22, borderRadius: "50%",
                  background: "linear-gradient(135deg,#2f81f7,#39d2f5)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 13, fontWeight: 700, color: "#fff"
                }}>G</span>
                <span className="hidden-sm">gallankusuma41</span>
                <span style={{ fontSize: 11 }}>▾</span>
              </div>

              {/* Hamburger — mobile only */}
              <button
                onClick={() => setMobileOpen(o => !o)}
                className="hamburger-btn"
                style={{
                  display: "none", background: "none",
                  border: "1px solid var(--border)", borderRadius: 6,
                  padding: "5px 8px", cursor: "pointer",
                  color: "var(--text-primary)", fontSize: 20, lineHeight: 1,
                }}
              >
                {mobileOpen ? "✕" : "☰"}
              </button>
            </div>
          </div>
        </div>

        {/* ── Row 2: Nav items ── */}
        <div style={{ borderTop: "1px solid var(--border)", background: "rgba(0,0,0,0.15)" }} className="nav-row">
          {/* The scroll belongs on THIS element, not its parent: this is the flex
              container that grows past the viewport once the type is larger, so
              putting overflow on the wrapper left it free to push the page. */}
          <div style={{ maxWidth: "none", padding: "0 32px", display: "flex", alignItems: "stretch",
                        overflowX: "auto", overflowY: "hidden" }}>

            {/* Primary items */}
            {PRIMARY_ITEMS.map(item => {
              const isActive = pathname === item.href;
              return (
                <Link key={item.href} href={item.href} style={navLinkStyle(isActive)}
                  onMouseEnter={e => { if (!isActive) (e.currentTarget as HTMLElement).style.color = "var(--text-primary)"; }}
                  onMouseLeave={e => { if (!isActive) (e.currentTarget as HTMLElement).style.color = "var(--text-secondary)"; }}
                >
                  <span style={{ fontSize: 16 }}>{item.icon}</span>
                  {item.label}
                  <Badge item={item} />
                </Link>
              );
            })}

            {/* More dropdown — uses ref for outside-click detection */}
            <div ref={moreRef} style={{ position: "relative", display: "flex", alignItems: "stretch" }}>
              <button
                onClick={() => setMoreOpen(o => !o)}
                style={{
                  display: "flex", alignItems: "center", gap: 5,
                  padding: "11px 14px", background: "none", border: "none", cursor: "pointer",
                  fontSize: 14, fontWeight: isMoreActive ? 700 : 500,
                  color: isMoreActive ? "#58a6ff" : "var(--text-secondary)",
                  borderBottom: isMoreActive ? "2px solid #58a6ff" : "2px solid transparent",
                  whiteSpace: "nowrap", letterSpacing: "0.04em",
                  transition: "color 0.15s, border-color 0.15s",
                }}
                onMouseEnter={e => { if (!isMoreActive) (e.currentTarget as HTMLElement).style.color = "var(--text-primary)"; }}
                onMouseLeave={e => { if (!isMoreActive) (e.currentTarget as HTMLElement).style.color = "var(--text-secondary)"; }}
              >
                ≡ More
                <span style={{
                  display: "inline-block", fontSize: 11,
                  transform: moreOpen ? "rotate(180deg)" : "rotate(0deg)",
                  transition: "transform 0.2s ease",
                }}>▾</span>
              </button>

              {/* Dropdown panel */}
              {moreOpen && (
                <div style={{
                  position: "absolute", top: "100%", left: 0, zIndex: 999,
                  background: "var(--bg-secondary)",
                  border: "1px solid var(--border)",
                  borderRadius: 10, padding: "6px 0",
                  minWidth: 210,
                  boxShadow: "0 12px 40px rgba(0,0,0,0.5)",
                  animation: "dropIn 0.15s ease",
                }}>
                  {MORE_ITEMS.map(item => {
                    const isActive = pathname === item.href;
                    const isStockbit = item.href === "/stockbit-connector";
                    return (
                      <Link
                        key={item.href}
                        href={item.href}
                        onClick={() => setMoreOpen(false)}
                        style={{
                          display: "flex", alignItems: "center", gap: 12,
                          padding: "11px 18px", textDecoration: "none",
                          fontSize: 16, fontWeight: isActive ? 700 : 400,
                          color: isActive ? "#58a6ff" : isStockbit ? "#3fb950" : "var(--text-primary)",
                          background: isActive ? "rgba(47,129,247,0.08)" : "transparent",
                          transition: "background 0.12s",
                          borderLeft: isActive ? "3px solid #58a6ff" : "3px solid transparent",
                        }}
                        onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.05)"; }}
                        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = isActive ? "rgba(47,129,247,0.08)" : "transparent"; }}
                      >
                        <span style={{ fontSize: 21, minWidth: 22, textAlign: "center" }}>{item.icon}</span>
                        <span style={{ flex: 1 }}>{item.label}</span>
                        <Badge item={item} />
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>

          </div>
        </div>

        {/* ── Mobile full menu ── */}
        {mobileOpen && (
          <div
            style={{
              position: "fixed", top: 96, left: 0, right: 0, bottom: 0, zIndex: 150,
              background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)",
            }}
            onClick={() => setMobileOpen(false)}
          >
            <div
              style={{ background: "var(--bg-secondary)", padding: "8px 0" }}
              onClick={e => e.stopPropagation()}
            >
              {NAV_ITEMS.map(item => {
                const isActive = pathname === item.href;
                return (
                  <Link
                    key={item.href} href={item.href}
                    onClick={() => setMobileOpen(false)}
                    style={{
                      display: "flex", alignItems: "center", gap: 14,
                      padding: "13px 24px", textDecoration: "none",
                      fontSize: 18, fontWeight: isActive ? 700 : 400,
                      color: isActive ? "#58a6ff" : "var(--text-primary)",
                      background: isActive ? "rgba(47,129,247,0.08)" : "transparent",
                      borderLeft: isActive ? "3px solid #58a6ff" : "3px solid transparent",
                    }}
                  >
                    <span style={{ fontSize: 23 }}>{item.icon}</span>
                    {item.label}
                    <Badge item={item} />
                  </Link>
                );
              })}
            </div>
          </div>
        )}
      </header>

      <style>{`
        @keyframes dropIn {
          from { opacity: 0; transform: translateY(-8px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @media (max-width: 900px) {
          .nav-row    { display: none !important; }
          .hamburger-btn { display: flex !important; align-items: center; }
          .hidden-sm  { display: none !important; }
        }
      `}</style>
    </>
  );
}
