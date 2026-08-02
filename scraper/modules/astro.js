/**
 * modules/astro.js
 * Lunar Phase Calculator — Jean Meeus "Astronomical Algorithms" Ch.49
 * Pure math, zero external dependencies.
 * Accuracy: ±2 minutes vs. official ephemeris.
 */

'use strict';

function toRad(deg) { return deg * Math.PI / 180; }

/** Julian Day from JS Date */
function dateToJD(date) {
  let y = date.getUTCFullYear();
  let m = date.getUTCMonth() + 1;
  const d = date.getUTCDate() + date.getUTCHours() / 24 + date.getUTCMinutes() / 1440;
  if (m <= 2) { y--; m += 12; }
  const A = Math.floor(y / 100);
  const B = 2 - A + Math.floor(A / 4);
  return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + d + B - 1524.5;
}

/** JS Date from Julian Day */
function jdToDate(jd) {
  const z = Math.floor(jd + 0.5);
  const f = (jd + 0.5) - z;
  let A = z;
  if (z >= 2299161) {
    const a = Math.floor((z - 1867216.25) / 36524.25);
    A = z + 1 + a - Math.floor(a / 4);
  }
  const B = A + 1524;
  const C = Math.floor((B - 122.1) / 365.25);
  const D = Math.floor(365.25 * C);
  const E = Math.floor((B - D) / 30.6001);
  const day   = B - D - Math.floor(30.6001 * E);
  const month = E < 14 ? E - 1 : E - 13;
  const year  = month > 2 ? C - 4716 : C - 4715;
  const hFrac = f * 24;
  const h = Math.floor(hFrac);
  const min = Math.round((hFrac - h) * 60);
  return new Date(Date.UTC(year, month - 1, day, h, min));
}

/**
 * Compute true JD of a lunar phase using Meeus Ch.49 corrections
 * k = integer → New Moon
 * k = integer + 0.5 → Full Moon
 */
function truePhaseJD(k) {
  const T  = k / 1236.85;
  const T2 = T * T;
  const T3 = T2 * T;

  // Mean JDE
  let JDE = 2451550.09766
    + 29.530588861 * k
    + 0.00015437  * T2
    - 0.000000150 * T3
    + 0.00000000073 * T2 * T2;

  const E  = 1 - 0.002516 * T - 0.0000074 * T2;
  const M  = toRad(2.5534  + 29.10535670 * k - 0.0000014  * T2);
  const Ml = toRad(201.5643 + 385.81693528 * k + 0.0107582 * T2 + 0.00001238 * T3);
  const F  = toRad(160.7108 + 390.67050284 * k - 0.0016118 * T2 - 0.00000227 * T3);
  const Om = toRad(124.7746 -   1.56375588 * k + 0.0020672 * T2);

  const isNew = Number.isInteger(k);

  if (isNew) {
    JDE +=
      -0.40720 * Math.sin(Ml)
      + 0.17241 * E * Math.sin(M)
      + 0.01608 * Math.sin(2 * Ml)
      + 0.01039 * Math.sin(2 * F)
      + 0.00739 * E * Math.sin(Ml - M)
      - 0.00514 * E * Math.sin(Ml + M)
      + 0.00208 * E * E * Math.sin(2 * M)
      - 0.00111 * Math.sin(Ml - 2 * F)
      - 0.00057 * Math.sin(Ml + 2 * F)
      + 0.00056 * E * Math.sin(2 * Ml + M)
      - 0.00042 * Math.sin(3 * Ml)
      + 0.00042 * E * Math.sin(M + 2 * F)
      + 0.00038 * E * Math.sin(M - 2 * F)
      - 0.00024 * E * Math.sin(2 * Ml - M)
      - 0.00017 * Math.sin(Om)
      - 0.00007 * Math.sin(Ml + 2 * M);
  } else {
    JDE +=
      -0.40614 * Math.sin(Ml)
      + 0.17302 * E * Math.sin(M)
      + 0.01614 * Math.sin(2 * Ml)
      + 0.01043 * Math.sin(2 * F)
      + 0.00734 * E * Math.sin(Ml - M)
      - 0.00515 * E * Math.sin(Ml + M)
      + 0.00209 * E * E * Math.sin(2 * M)
      - 0.00111 * Math.sin(Ml - 2 * F)
      - 0.00057 * Math.sin(Ml + 2 * F)
      + 0.00056 * E * Math.sin(2 * Ml + M)
      - 0.00042 * Math.sin(3 * Ml)
      + 0.00042 * E * Math.sin(M + 2 * F)
      + 0.00038 * E * Math.sin(M - 2 * F)
      - 0.00024 * E * Math.sin(2 * Ml - M)
      - 0.00017 * Math.sin(Om)
      - 0.00007 * Math.sin(Ml + 2 * M);
  }

  return JDE;
}

/**
 * Get all New Moon + Full Moon events between two JS Dates
 * @param {Date} fromDate
 * @param {Date} toDate
 * @returns {Array} sorted events: { type, date, dateStr, label, color, emoji }
 */
function getLunarEvents(fromDate, toDate) {
  const events = [];
  const yr0 = fromDate.getUTCFullYear() + (fromDate.getUTCMonth()) / 12;
  let k = Math.floor((yr0 - 2000) * 12.3685);

  // Scan a wide window to not miss any events
  const maxK = k + Math.ceil(((toDate - fromDate) / 86400000) / 29.53) + 2;

  for (; k <= maxK; k++) {
    // New Moon (integer k)
    const newJD   = truePhaseJD(k);
    const newDate = jdToDate(newJD);
    if (newDate >= fromDate && newDate <= toDate) {
      events.push({
        type:    'new_moon',
        date:    newDate,
        dateStr: newDate.toISOString().split('T')[0],
        label:   'New Moon',
        emoji:   '🌑',
        color:   '#6e7681',
      });
    }

    // Full Moon (k + 0.5)
    const fullJD   = truePhaseJD(k + 0.5);
    const fullDate = jdToDate(fullJD);
    if (fullDate >= fromDate && fullDate <= toDate) {
      events.push({
        type:    'full_moon',
        date:    fullDate,
        dateStr: fullDate.toISOString().split('T')[0],
        label:   'Full Moon',
        emoji:   '🌕',
        color:   '#f7c948',
      });
    }
  }

  return events.sort((a, b) => a.date - b.date);
}

module.exports = { getLunarEvents };
