'use client';

import { checkDataFreshness } from '@/lib/dataFreshness';

export default function DataFreshnessBanner({ d0 }: { d0?: string | null }) {
  const { stale, actual, expected } = checkDataFreshness(d0);
  if (!stale || !actual) return null;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '10px 14px',
        marginBottom: 16,
        borderRadius: 8,
        border: '1px solid var(--accent-red)',
        background: 'color-mix(in srgb, var(--accent-red) 12%, transparent)',
        color: 'var(--text-primary)',
        fontSize: 13,
      }}
    >
      <span>⚠️</span>
      <span>
        Data terakhir: <strong>{actual}</strong>, harusnya sudah <strong>{expected}</strong>.
        Kemungkinan pull data semalam gagal — cek <code>/api/cron/status</code> sebelum dipakai buat keputusan premarket.
      </span>
    </div>
  );
}
