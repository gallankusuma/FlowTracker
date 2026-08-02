// ==UserScript==
// @name         FlowTracker — IDX Broker Data Copier
// @namespace    http://flowtracker.dipasukses.com/
// @version      1.0
// @description  Auto-copy broker summary data from RTI Business / Stockbit for FlowTracker upload
// @author       FlowTracker Team
// @match        https://www.rti.co.id/*
// @match        https://rti.co.id/*
// @match        https://www.rtibusiness.co.id/*
// @match        https://rtibusiness.co.id/*
// @match        https://stockbit.com/*
// @match        https://www.idx.co.id/*
// @grant        GM_setClipboard
// @grant        GM_notification
// ==/UserScript==

(function() {
    'use strict';

    // FlowTracker VPS API URL
    const FLOWTRACKER_API = 'http://76.13.22.155:3100';

    // Create floating panel
    const panel = document.createElement('div');
    panel.id = 'ft-panel';
    panel.innerHTML = `
        <style>
            #ft-panel {
                position: fixed;
                bottom: 20px;
                right: 20px;
                width: 320px;
                background: linear-gradient(135deg, #0d1117, #161b22);
                border: 1px solid #30363d;
                border-radius: 16px;
                box-shadow: 0 20px 50px rgba(0,0,0,0.5);
                z-index: 99999;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
                color: #c9d1d9;
                overflow: hidden;
            }
            #ft-panel .ft-header {
                padding: 14px 16px;
                background: linear-gradient(135deg, #2f81f7, #39d2f5);
                color: #fff;
                font-weight: 800;
                font-size: 13px;
                letter-spacing: 0.06em;
                display: flex;
                align-items: center;
                justify-content: space-between;
                cursor: move;
            }
            #ft-panel .ft-body {
                padding: 16px;
            }
            #ft-panel label {
                font-size: 10px;
                color: #8b949e;
                letter-spacing: 0.1em;
                display: block;
                margin-bottom: 4px;
            }
            #ft-panel input, #ft-panel select {
                width: 100%;
                padding: 8px 12px;
                background: #0d1117;
                border: 1px solid #30363d;
                border-radius: 8px;
                color: #c9d1d9;
                font-size: 13px;
                margin-bottom: 10px;
                box-sizing: border-box;
            }
            #ft-panel .ft-btn {
                width: 100%;
                padding: 10px;
                border: none;
                border-radius: 10px;
                font-weight: 800;
                font-size: 12px;
                cursor: pointer;
                letter-spacing: 0.06em;
                transition: all 0.2s;
            }
            #ft-panel .ft-btn-primary {
                background: linear-gradient(135deg, #2f81f7, #39d2f5);
                color: #fff;
            }
            #ft-panel .ft-btn-primary:hover {
                transform: translateY(-2px);
                box-shadow: 0 6px 20px rgba(47,129,247,0.4);
            }
            #ft-panel .ft-btn-secondary {
                background: #21262d;
                color: #c9d1d9;
                border: 1px solid #30363d;
                margin-top: 8px;
            }
            #ft-panel .ft-status {
                margin-top: 12px;
                padding: 10px;
                border-radius: 8px;
                font-size: 11px;
                display: none;
            }
            #ft-panel .ft-status.success {
                background: rgba(63,185,80,0.15);
                border: 1px solid rgba(63,185,80,0.3);
                color: #3fb950;
                display: block;
            }
            #ft-panel .ft-status.error {
                background: rgba(248,81,73,0.15);
                border: 1px solid rgba(248,81,73,0.3);
                color: #f85149;
                display: block;
            }
            #ft-panel .ft-minimize {
                cursor: pointer;
                font-size: 16px;
            }
        </style>
        <div class="ft-header">
            <span>📊 FLOWTRACKER COPIER</span>
            <span class="ft-minimize" id="ft-minimize">−</span>
        </div>
        <div class="ft-body" id="ft-body">
            <label>BROKER CODE</label>
            <input type="text" id="ft-broker" placeholder="e.g. MG" maxlength="2" style="text-transform:uppercase;font-weight:800;letter-spacing:0.2em;text-align:center;font-size:18px;">

            <label>DATE</label>
            <input type="date" id="ft-date" value="${new Date().toISOString().split('T')[0]}">

            <button class="ft-btn ft-btn-primary" id="ft-copy">
                📋 COPY TABLE DATA & UPLOAD
            </button>
            <button class="ft-btn ft-btn-secondary" id="ft-select">
                🔍 SELECT TABLE ON PAGE
            </button>

            <div class="ft-status" id="ft-status"></div>

            <div style="margin-top:12px;padding-top:12px;border-top:1px solid #21262d;">
                <div style="font-size:10px;color:#484f58;letter-spacing:0.08em;margin-bottom:6px;">QUICK GUIDE</div>
                <div style="font-size:11px;color:#8b949e;line-height:1.6;">
                    1. Buka halaman Broker Summary di RTI/Stockbit<br>
                    2. Pilih broker code (mis: MG)<br>
                    3. Klik <strong style="color:#2f81f7">COPY TABLE DATA</strong><br>
                    4. Data auto-upload ke FlowTracker! ✨
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(panel);

    // Minimize toggle
    let minimized = false;
    document.getElementById('ft-minimize').addEventListener('click', () => {
        minimized = !minimized;
        document.getElementById('ft-body').style.display = minimized ? 'none' : 'block';
        document.getElementById('ft-minimize').textContent = minimized ? '+' : '−';
    });

    // Status helper
    function setStatus(msg, type) {
        const el = document.getElementById('ft-status');
        el.textContent = msg;
        el.className = 'ft-status ' + type;
    }

    // Extract table data from current page
    function extractTableData() {
        const tables = document.querySelectorAll('table');
        let bestTable = null;
        let maxRows = 0;

        tables.forEach(table => {
            const rows = table.querySelectorAll('tbody tr, tr');
            if (rows.length > maxRows) {
                maxRows = rows.length;
                bestTable = table;
            }
        });

        if (!bestTable) return null;

        const rows = bestTable.querySelectorAll('tbody tr, tr');
        const data = [];

        rows.forEach(row => {
            const cells = Array.from(row.querySelectorAll('td, th'));
            const values = cells.map(c => c.textContent.trim().replace(/\s+/g, ' '));
            if (values.length >= 5 && values.some(v => /\d/.test(v))) {
                data.push(values.join(','));
            }
        });

        return data.length > 0 ? data.join('\n') : null;
    }

    // Parse and upload data
    async function uploadToFlowTracker(csvData, brokerCode, date) {
        try {
            const response = await fetch(`${FLOWTRACKER_API}/api/upload-broker-data`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    broker_code: brokerCode,
                    date: date,
                    format: 'csv',
                    data: csvData,
                }),
            });

            const result = await response.json();
            return result;
        } catch (err) {
            return { success: false, error: err.message };
        }
    }

    // Copy button handler
    document.getElementById('ft-copy').addEventListener('click', async () => {
        const brokerCode = document.getElementById('ft-broker').value.toUpperCase().trim();
        const date = document.getElementById('ft-date').value;

        if (!brokerCode || brokerCode.length < 2) {
            setStatus('❌ Masukkan broker code dulu (mis: MG)', 'error');
            return;
        }

        setStatus('⏳ Extracting table data...', 'success');

        // Try to extract table data
        const tableData = extractTableData();

        if (!tableData) {
            // Fallback: try to get selected text
            const selected = window.getSelection().toString().trim();
            if (!selected) {
                setStatus('❌ No table found. Select data manually first.', 'error');
                return;
            }
            // Use selected text
            const result = await uploadToFlowTracker(selected, brokerCode, date);
            if (result.success || result.inserted) {
                setStatus(`✅ Uploaded! ${result.inserted || result.count || 0} records`, 'success');
            } else {
                setStatus(`❌ Upload failed: ${result.error || 'Unknown error'}`, 'error');
            }
            return;
        }

        // Copy to clipboard too
        if (typeof GM_setClipboard !== 'undefined') {
            GM_setClipboard(tableData, 'text');
        } else {
            navigator.clipboard.writeText(tableData).catch(() => {});
        }

        // Upload to FlowTracker
        setStatus('⏳ Uploading to FlowTracker...', 'success');
        const result = await uploadToFlowTracker(tableData, brokerCode, date);

        if (result.success || result.inserted) {
            setStatus(`✅ Success! ${result.inserted || result.count || 0} records uploaded to FlowTracker`, 'success');
            if (typeof GM_notification !== 'undefined') {
                GM_notification({
                    title: 'FlowTracker',
                    text: `${brokerCode} data uploaded: ${result.inserted || 0} records`,
                    timeout: 3000,
                });
            }
        } else {
            setStatus(`❌ Error: ${result.error || 'Upload failed'}`, 'error');
        }
    });

    // Select button: highlight tables
    document.getElementById('ft-select').addEventListener('click', () => {
        const tables = document.querySelectorAll('table');
        tables.forEach((table, i) => {
            table.style.outline = '3px solid #2f81f7';
            table.style.outlineOffset = '4px';
            table.title = `Table ${i + 1} — Click to select`;
            table.style.cursor = 'pointer';

            table.addEventListener('click', (e) => {
                e.stopPropagation();
                // Select all text in this table
                const range = document.createRange();
                range.selectNodeContents(table);
                window.getSelection().removeAllRanges();
                window.getSelection().addRange(range);
                setStatus(`📋 Table ${i + 1} selected. Now click COPY TABLE DATA.`, 'success');
            }, { once: true });
        });

        setStatus(`Found ${tables.length} table(s). Click one to select.`, 'success');
    });

    console.log('📊 FlowTracker Copier loaded!');
})();
