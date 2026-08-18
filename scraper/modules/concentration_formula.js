'use strict';
/**
 * Signed top-3 broker concentration — the flowtracker.id definition.
 *
 * RECOVERED, NOT INVENTED. Our own formula had drifted into something that
 * shared a name with the reference site and nothing else, so the definition was
 * solved for from data rather than guessed: five ANTM sessions were read off the
 * reference site, the numerator was assumed to be "the top brokers by |net|",
 * and the denominator was back-solved per session. It landed on the SAME
 * quantity — the sum of all positive broker nets — on all five, and reproduces
 * the reference to 0.00 / 0.02 / 0.04 / 0.15 / 0.33 percentage points.
 *
 *     concentration = ( net of top 3 net BUYERS + net of top 3 net SELLERS )
 *                     ----------------------------------------------------- x 100
 *                                  sum of all positive nets
 *
 * Read it as: of all the money that was net accumulated today, how much of it
 * is the big accumulators, once the big distributors are netted back out. A
 * positive number is buyer-dominant, a negative one seller-dominant.
 *
 * WHY THE DENOMINATOR IS THE POSITIVE SIDE AND NOT SUM|net|. In a matched
 * market total buy equals total sell, so the positive nets and the negative nets
 * are equal and opposite and SUM|net| is exactly twice the positive side. Using
 * SUM|net| therefore halves every value — that is precisely the shape of the old
 * divergence, and it is why the metric must name which side it normalises by.
 *
 * A KNOWN AMBIGUITY, RECORDED RATHER THAN HIDDEN. On all five reference sessions
 * the top 6 brokers by |net| happened to split exactly 3 buyers / 3 sellers, so
 * that sample cannot distinguish "top 3 per side" from "top 6 by magnitude".
 * Across the universe the two disagree on 52% of ticker-sessions (max gap 60
 * points), so the choice matters. This implements TOP 3 PER SIDE, which is what
 * the reference site's own column label ("TOP 3 BROKER CONCENTRATION") says and
 * what the buyer/seller framing implies. Confirming it needs reference values
 * for a session where the top 6 by |net| are NOT 3/3 — see
 * test_concentration_formula.js, which pins the distinction with a fixture.
 *
 * NG (negotiated market) DELIBERATELY PLAYS NO PART. The previous model blended
 * an NG concentration at 0.6 weight. In NG a crossing puts the same broker on
 * both legs, so per-broker net cancels to zero while per-row |net| does not —
 * the blend was therefore applying a 60% weight to a structural zero on 31.8% of
 * ticker-days, publishing 0.4x our own signal. The reference figures are
 * reproduced from the regular market alone, so NG is simply not part of this
 * definition.
 */

/**
 * @param {number[]} brokerNets one net value PER BROKER (already aggregated —
 *        passing per-row values would let a single broker occupy several of the
 *        top-3 slots and silently overstate concentration).
 * @returns {number|null} percentage in [-100, 100], or null when there is no
 *        accumulation to measure against. Null is not zero: zero is a real
 *        reading of a balanced market, null means the question does not apply.
 */
function signedTop3Concentration(brokerNets) {
  const nets = (brokerNets || []).map(Number).filter(Number.isFinite);

  const positives = nets.filter(n => n > 0).sort((a, b) => b - a);
  const negatives = nets.filter(n => n < 0).sort((a, b) => a - b);

  const posTotal = positives.reduce((a, b) => a + b, 0);
  if (!(posTotal > 0)) return null;

  const sum = a => a.reduce((x, y) => x + y, 0);
  const top3Buy  = sum(positives.slice(0, 3));
  const top3Sell = sum(negatives.slice(0, 3));

  return ((top3Buy + top3Sell) / posTotal) * 100;
}

/** Rounded the way the reference site presents it. */
function signedTop3ConcentrationRounded(brokerNets) {
  const v = signedTop3Concentration(brokerNets);
  return v === null ? null : Math.round(v * 100) / 100;
}

module.exports = { signedTop3Concentration, signedTop3ConcentrationRounded };
