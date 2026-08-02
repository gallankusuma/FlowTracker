"use client";
import { useState } from "react";

const SCRIPT_CONTENT = `// ==UserScript==
// @name         FlowTracker Copier
// @namespace    http://flowtracker.dipasukses.com/
// @version      1.0
// @description  Auto-copy broker data from RTI/Stockbit
// @match        https://*.rti.co.id/*
// @match        https://*.rtibusiness.co.id/*
// @match        https://stockbit.com/*
// @match        https://*.idx.co.id/*
// @grant        GM_setClipboard
// ==/UserScript==
(function(){
  'use strict';
  const API='http://76.13.22.155:3100';
  const p=document.createElement('div');
  p.id='ft-cp';
  p.innerHTML=\`<div style="position:fixed;bottom:20px;right:20px;width:300px;background:#0d1117;border:1px solid #30363d;border-radius:16px;box-shadow:0 20px 50px rgba(0,0,0,.5);z-index:99999;font-family:system-ui;color:#c9d1d9"><div style="padding:12px 16px;background:linear-gradient(135deg,#2f81f7,#39d2f5);color:#fff;font-weight:800;font-size:13px;border-radius:16px 16px 0 0">📊 FLOWTRACKER COPIER</div><div style="padding:16px"><label style="font-size:10px;color:#8b949e;display:block;margin-bottom:4px">BROKER CODE</label><input id="ft-bc" maxlength="2" style="width:100%;padding:8px;background:#161b22;border:1px solid #30363d;border-radius:8px;color:#c9d1d9;font-size:18px;font-weight:800;text-align:center;text-transform:uppercase;box-sizing:border-box;margin-bottom:10px"><label style="font-size:10px;color:#8b949e;display:block;margin-bottom:4px">DATE</label><input id="ft-dt" type="date" style="width:100%;padding:8px;background:#161b22;border:1px solid #30363d;border-radius:8px;color:#c9d1d9;box-sizing:border-box;margin-bottom:12px"><button id="ft-go" style="width:100%;padding:10px;background:linear-gradient(135deg,#2f81f7,#39d2f5);color:#fff;border:none;border-radius:10px;font-weight:800;font-size:12px;cursor:pointer">📋 COPY & UPLOAD</button><div id="ft-st" style="margin-top:10px;font-size:11px;display:none"></div></div></div>\`;
  document.body.appendChild(p);
  document.getElementById('ft-dt').value=new Date().toISOString().split('T')[0];
  document.getElementById('ft-go').onclick=async()=>{
    const bc=document.getElementById('ft-bc').value.toUpperCase();
    const dt=document.getElementById('ft-dt').value;
    const st=document.getElementById('ft-st');
    if(!bc||bc.length<2){st.style.display='block';st.style.color='#f85149';st.textContent='❌ Masukkan broker code';return}
    const tables=document.querySelectorAll('table');
    let best=null,max=0;
    tables.forEach(t=>{const r=t.querySelectorAll('tr');if(r.length>max){max=r.length;best=t}});
    if(!best){st.style.display='block';st.style.color='#f85149';st.textContent='❌ No table found';return}
    const rows=best.querySelectorAll('tr');
    const csv=[];
    rows.forEach(r=>{const c=Array.from(r.querySelectorAll('td,th')).map(x=>x.textContent.trim());if(c.length>=5&&c.some(v=>/\\d/.test(v)))csv.push(c.join(','))});
    st.style.display='block';st.style.color='#39d2f5';st.textContent='⏳ Uploading...';
    try{
      const res=await fetch(API+'/api/broker-summary/upload-csv',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({brokerCode:bc,date:dt,csv:csv.join('\\n')})});
      const j=await res.json();
      st.style.color='#3fb950';st.textContent='✅ '+( j.parsed||0)+' records uploaded!';
    }catch(e){st.style.color='#f85149';st.textContent='❌ '+e.message}
  };
})();`;

export default function TampermonkeyPanel() {
  const [copied, setCopied] = useState(false);

  const downloadScript = () => {
    const blob = new Blob([SCRIPT_CONTENT], { type: "text/javascript" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "flowtracker-copier.user.js";
    a.click();
    URL.revokeObjectURL(url);
  };

  const copyScript = () => {
    navigator.clipboard.writeText(SCRIPT_CONTENT);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const cardStyle: React.CSSProperties = {
    padding: 20, borderRadius: 12,
    background: "var(--bg-secondary)", border: "1px solid var(--border)", marginBottom: 16,
  };

  return (
    <div>
      {/* Install Guide */}
      <div style={cardStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
          <span style={{ fontSize: 20 }}>🐒</span>
          <h3 style={{ margin: 0, fontSize: 14, fontWeight: 800, color: "var(--text-primary)" }}>
            TAMPERMONKEY SCRIPT
          </h3>
        </div>
        <p style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.7, margin: "0 0 16px" }}>
          Install script ini di browser lo untuk auto-copy data broker dari <strong style={{ color: "var(--accent-cyan)" }}>RTI Business</strong> atau <strong style={{ color: "var(--accent-cyan)" }}>Stockbit</strong> langsung ke FlowTracker.
        </p>

        <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
          <button onClick={downloadScript}
            style={{ flex: 1, padding: "12px 16px", borderRadius: 10, fontWeight: 800, fontSize: 13,
              background: "linear-gradient(135deg, #2f81f7, #39d2f5)", color: "#fff",
              border: "none", cursor: "pointer", letterSpacing: "0.04em",
              boxShadow: "0 4px 16px rgba(47,129,247,0.3)" }}>
            ⬇️ DOWNLOAD SCRIPT
          </button>
          <button onClick={copyScript}
            style={{ padding: "12px 16px", borderRadius: 10, fontWeight: 700, fontSize: 12,
              background: copied ? "rgba(63,185,80,0.15)" : "var(--bg-primary)",
              color: copied ? "var(--accent-green)" : "var(--text-secondary)",
              border: `1px solid ${copied ? "rgba(63,185,80,0.3)" : "var(--border)"}`,
              cursor: "pointer", whiteSpace: "nowrap" }}>
            {copied ? "✅ COPIED!" : "📋 COPY"}
          </button>
        </div>

        {/* Steps */}
        <div style={{ background: "var(--bg-primary)", borderRadius: 10, padding: 16, border: "1px solid var(--border)" }}>
          <h4 style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", letterSpacing: "0.1em", margin: "0 0 12px" }}>
            📖 CARA INSTALL
          </h4>
          <ol style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: "var(--text-secondary)", lineHeight: 2.2 }}>
            <li>Install <a href="https://www.tampermonkey.net/" target="_blank" style={{ color: "var(--accent-cyan)" }}>Tampermonkey</a> extension di Chrome</li>
            <li>Klik <strong style={{ color: "var(--accent-blue)" }}>DOWNLOAD SCRIPT</strong> di atas</li>
            <li>Tampermonkey otomatis detect → klik <strong>Install</strong></li>
            <li>Buka <a href="https://www.rtibusiness.co.id" target="_blank" style={{ color: "var(--accent-cyan)" }}>RTI Business</a> atau <a href="https://stockbit.com" target="_blank" style={{ color: "var(--accent-cyan)" }}>Stockbit</a></li>
            <li>Panel FlowTracker muncul di kanan bawah 🎯</li>
            <li>Masukkan broker code → data auto-upload! ✨</li>
          </ol>
        </div>
      </div>

      {/* Supported Sites */}
      <div style={cardStyle}>
        <h3 style={{ fontSize: 12, fontWeight: 700, color: "var(--text-muted)", letterSpacing: "0.1em", margin: "0 0 14px" }}>
          🌐 SUPPORTED SITES
        </h3>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {[
            { name: "RTI Business", url: "rtibusiness.co.id", icon: "📊" },
            { name: "Stockbit", url: "stockbit.com", icon: "📈" },
            { name: "IDX", url: "idx.co.id", icon: "🏛️" },
          ].map(s => (
            <div key={s.url} style={{ display: "flex", alignItems: "center", gap: 10,
              padding: "10px 14px", borderRadius: 8, background: "var(--bg-primary)",
              border: "1px solid var(--border)" }}>
              <span style={{ fontSize: 18 }}>{s.icon}</span>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)" }}>{s.name}</div>
                <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{s.url}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Script Preview */}
      <div style={cardStyle}>
        <h3 style={{ fontSize: 12, fontWeight: 700, color: "var(--text-muted)", letterSpacing: "0.1em", margin: "0 0 12px" }}>
          👁️ SCRIPT PREVIEW
        </h3>
        <pre style={{ margin: 0, fontSize: 10, color: "var(--text-muted)", maxHeight: 200,
          overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all",
          background: "var(--bg-primary)", padding: 12, borderRadius: 8,
          border: "1px solid var(--border)" }}>
          {SCRIPT_CONTENT.slice(0, 1500)}...
        </pre>
      </div>
    </div>
  );
}
