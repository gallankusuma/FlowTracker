/**
 * Broker Category Color Utility
 * Source of truth: ft_broker_config table in DB
 * 
 * 3 categories:
 *   FOREIGN   → Blue  (#3b82f6) — foreign-owned brokers (UBS, JPM, Macquarie, etc.)
 *   BIG_MONEY → Gold  (#f59e0b) — institutional domestic brokers
 *   RITEL     → Gray  (#8b949e) — retail-oriented brokers
 */

export type BrokerCategory = 'FOREIGN' | 'BIG_MONEY' | 'RITEL';

// ── Color palette ──────────────────────────────────────────────────
export const BROKER_COLORS: Record<BrokerCategory, {
  text: string;
  bg: string;
  border: string;
  label: string;
}> = {
  FOREIGN: {
    text:   '#60a5fa',
    bg:     'rgba(59,130,246,0.12)',
    border: 'rgba(59,130,246,0.35)',
    label:  'Foreign',
  },
  BIG_MONEY: {
    text:   '#fbbf24',
    bg:     'rgba(245,158,11,0.12)',
    border: 'rgba(245,158,11,0.35)',
    label:  'Big Money',
  },
  RITEL: {
    text:   '#8b949e',
    bg:     'rgba(139,148,158,0.08)',
    border: 'rgba(139,148,158,0.25)',
    label:  'Ritel',
  },
};

// ── Static broker → category map (synced from ft_broker_config) ────
// To refresh: mysql -u root erp_manufacturing -e "SELECT code, category FROM ft_broker_config WHERE active=1"
export const BROKER_CATEGORY_MAP: Record<string, BrokerCategory> = {
  // FOREIGN — foreign-majority-owned brokers
  AG: 'FOREIGN', AH: 'FOREIGN', AI: 'FOREIGN', AK: 'FOREIGN',
  BK: 'FOREIGN', BQ: 'FOREIGN', CP: 'FOREIGN', DP: 'FOREIGN',
  DR: 'FOREIGN', FS: 'FOREIGN', HD: 'FOREIGN', KK: 'FOREIGN',
  KZ: 'FOREIGN', RX: 'FOREIGN', TP: 'FOREIGN', XA: 'FOREIGN',
  YP: 'FOREIGN', YU: 'FOREIGN', ZP: 'FOREIGN',

  // BIG_MONEY — institutional domestic brokers
  AD: 'BIG_MONEY', AF: 'BIG_MONEY', AO: 'BIG_MONEY', AP: 'BIG_MONEY',
  AR: 'BIG_MONEY', AZ: 'BIG_MONEY', BB: 'BIG_MONEY', BF: 'BIG_MONEY',
  BR: 'BIG_MONEY', BS: 'BIG_MONEY', CC: 'BIG_MONEY', CD: 'BIG_MONEY',
  DD: 'BIG_MONEY', DH: 'BIG_MONEY', DU: 'BIG_MONEY', DX: 'BIG_MONEY',
  EL: 'BIG_MONEY', EP: 'BIG_MONEY', ES: 'BIG_MONEY', FO: 'BIG_MONEY',
  FZ: 'BIG_MONEY', GA: 'BIG_MONEY', GR: 'BIG_MONEY',
  HP: 'BIG_MONEY', IC: 'BIG_MONEY', ID: 'BIG_MONEY', IF: 'BIG_MONEY',
  IH: 'BIG_MONEY', II: 'BIG_MONEY', IN: 'BIG_MONEY', IT: 'BIG_MONEY',
  IU: 'BIG_MONEY', JB: 'BIG_MONEY', KI: 'BIG_MONEY', LG: 'BIG_MONEY',
  LS: 'BIG_MONEY', MG: 'BIG_MONEY', MI: 'BIG_MONEY', MU: 'BIG_MONEY',
  NI: 'BIG_MONEY', OD: 'BIG_MONEY', OK: 'BIG_MONEY', PC: 'BIG_MONEY', PF: 'BIG_MONEY',
  PG: 'BIG_MONEY', PI: 'BIG_MONEY', PO: 'BIG_MONEY', PP: 'BIG_MONEY',
  QA: 'BIG_MONEY', RB: 'BIG_MONEY', RF: 'BIG_MONEY', RG: 'BIG_MONEY',
  RS: 'BIG_MONEY', SA: 'BIG_MONEY', SF: 'BIG_MONEY', SH: 'BIG_MONEY',
  SQ: 'BIG_MONEY', SS: 'BIG_MONEY', TF: 'BIG_MONEY', TS: 'BIG_MONEY',
  YB: 'BIG_MONEY', YJ: 'BIG_MONEY', YO: 'BIG_MONEY', ZR: 'BIG_MONEY',

  // RITEL — retail-oriented brokers
  AT: 'RITEL', GI: 'RITEL', PD: 'RITEL',
  RO: 'RITEL', XC: 'RITEL', XL: 'RITEL',
};

// ── Helper functions ───────────────────────────────────────────────

/** Get category of a broker code, defaults to RITEL if unknown */
export function getBrokerCategory(code: string): BrokerCategory {
  return BROKER_CATEGORY_MAP[code?.toUpperCase()] ?? 'RITEL';
}

/** Get color object for a broker code */
export function getBrokerColors(code: string) {
  const cat = getBrokerCategory(code);
  return BROKER_COLORS[cat];
}

/** Get just the text color for a broker code */
export function getBrokerTextColor(code: string): string {
  return getBrokerColors(code).text;
}

/**
 * BrokerBadge style props — use spread into a style object
 * Usage: <span style={{ ...brokerBadgeStyle(code) }}>{code}</span>
 */
export function brokerBadgeStyle(code: string): React.CSSProperties {
  const c = getBrokerColors(code);
  return {
    display:      'inline-block',
    padding:      '2px 8px',
    borderRadius: 5,
    background:   c.bg,
    border:       `1px solid ${c.border}`,
    color:        c.text,
    fontSize:     12,
    fontWeight:   800,
    letterSpacing: '0.02em',
  };
}
