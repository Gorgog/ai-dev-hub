"""Statistics of step 0 (acceptance §4): does the rate of rule violations per opportunity grow with the depth of the
context epoch?

An opportunity: {stratum, rule, depth, v} - stratum is a thread (a session's main thread or a subagent) x a rule, depth
is the call's number in its epoch, v - 1 if violated. Slope - the within-stratum least-squares slope of v on log2(depth):
the stratum's base rate (the session, the rule, its era) is out of it. p - one-sided, depths permuted within strata.
Ratio - the late bucket against the early one, each as observed / expected, expected by the rule's own rate in the
thread kind: the mix of rules over depth is out of it. Stdlib only, deterministic for a seed.
"""
import math
import random
import statistics as st

BUCKETS = {
    'main': [(1, 50), (51, 150), (151, 300), (301, None)],
    'subagents': [(1, 10), (11, 30), (31, 60), (61, None)],
}
P_MAX = 0.1          # §4: one-sided p <= 0.1
RATIO_MIN = 1.3      # §4: the late bucket >= 1.3x the early one
LATE_MIN = 100       # fewer opportunities in the late bucket - too little data for a verdict
BORDER = 0.1         # §5: a value closer than 10 % to its threshold is borderline
YES, NO, LITTLE = 'распад есть', 'распада нет', 'мало данных'


def label(lo, hi):
    return f'{lo}+' if hi is None else f'{lo}-{hi}'


def bucket(depth, kind):
    """Index of the depth's bucket; depth < 1 (a report before any call of the epoch) is the first."""
    for i, (lo, hi) in enumerate(BUCKETS[kind]):
        if hi is None or depth <= hi:
            return i
    return len(BUCKETS[kind]) - 1


def counts(opps):
    return {'opps': len(opps), 'viol': sum(o['v'] for o in opps)}


def slope_test(opps, perms, seed):
    """(slope per doubling of depth, one-sided p); (None, None) when no stratum has depths that differ."""
    strata = {}
    for o in opps:
        strata.setdefault(o['stratum'], []).append((math.log2(max(o['depth'], 1)), o['v']))
    sxx = sxv = 0.0
    fixed = 0.0  # strata that no permutation changes add the same to every permuted numerator
    mixed = []   # (xs, total of xs, k violations, mean) of strata where the permutation moves anything
    for key in sorted(strata):
        rows = strata[key]
        xs = [x for x, _ in rows]
        mean = sum(xs) / len(xs)
        sxx += sum((x - mean) ** 2 for x in xs)
        k = sum(v for _, v in rows)
        part = sum(x for x, v in rows if v) - k * mean
        sxv += part
        if 0 < k < len(xs) and min(xs) != max(xs):
            mixed.append((xs, sum(xs), k, mean))
        else:
            fixed += part
    if sxx == 0:
        return None, None
    rng = random.Random(seed)
    hits = 0
    for _ in range(perms):
        num = fixed
        for xs, total, k, mean in mixed:
            m = min(k, len(xs) - k)
            s = sum(rng.sample(xs, m))
            num += (s if m == k else total - s) - k * mean
        if num >= sxv - 1e-9:
            hits += 1
    return sxv / sxx, (1 + hits) / (perms + 1)


def oe_ratio(opps, kind, by='rule'):
    """(late/early, each observed / expected, raw late/early, early has no violation while late has); expected - the
    violation rate of the opportunity's rule in the thread kind, or of its stratum (session x rule) with by='stratum'."""
    groups = {}
    for o in opps:
        c = groups.setdefault(o[by], [0, 0])
        c[0] += 1
        c[1] += o['v']
    rate = {g: v / n for g, (n, v) in groups.items()}
    last = len(BUCKETS[kind]) - 1
    part = {0: [0, 0.0, 0], last: [0, 0.0, 0]}  # observed, expected, opportunities
    for o in opps:
        b = bucket(o['depth'], kind)
        if b in part:
            part[b][0] += o['v']
            part[b][1] += rate[o[by]]
            part[b][2] += 1
    (oe, ee, ne), (ol, el, nl) = part[0], part[last]
    std = raw = None
    if oe and ee and el:
        std = round((ol / el) / (oe / ee), 3)
    if oe and ne and nl:
        raw = round((ol / nl) / (oe / ne), 3)
    return std, raw, oe == 0 and ol > 0


def near(x, threshold, closed_low=True):
    """Within 10 % of the threshold (§5); for p the interval is (0.09; 0.11], as the method has it."""
    lo, hi = threshold * (1 - BORDER), threshold * (1 + BORDER)
    return x is not None and (lo <= x if closed_low else lo < x) and x <= hi


def thread_stats(opps, kind, perms=10000, seed=11, diagnostics=True):
    """Buckets, per rule counts, slope and p, ratios and the verdict of §4 for one thread kind. Diagnostics - out of
    the verdict: each rule on its own, and the late/early ratio with the expectation of the session x rule."""
    rows = [[] for _ in BUCKETS[kind]]
    for o in opps:
        rows[bucket(o['depth'], kind)].append(o)
    buckets = [{'label': label(lo, hi), **counts(r)} for (lo, hi), r in zip(BUCKETS[kind], rows)]
    by_rule = {}
    for o in opps:
        by_rule.setdefault(o['rule'], []).append(o)
    slope, p = slope_test(opps, perms, seed)
    ratio, raw, early_zero = oe_ratio(opps, kind)
    late = buckets[-1]['opps']
    ratio_ok = early_zero or (ratio is not None and ratio >= RATIO_MIN)
    if late < LATE_MIN:
        verdict = LITTLE
    elif p is not None and p <= P_MAX and ratio_ok:
        verdict = YES
    else:
        verdict = NO
    depths = sorted(o['depth'] for o in opps)
    diag = None
    if diagnostics:
        keep = ('buckets', 'p', 'ratio', 'raw_ratio', 'slope_per_doubling')
        diag = {'session_ratio': oe_ratio(opps, kind, 'stratum')[0],
                'by_rule': {r: {k: v for k, v in thread_stats(os_, kind, perms, seed, False).items() if k in keep}
                            for r, os_ in sorted(by_rule.items())}}
    return {
        'diagnostics': diag,
        'buckets': buckets,
        'by_rule': {r: counts(os_) for r, os_ in sorted(by_rule.items())},
        'slope_per_doubling': None if slope is None else round(slope, 5),
        'p': None if p is None else round(p, 4),
        'ratio': ratio,
        'raw_ratio': raw,
        'early_zero': early_zero,
        'verdict': verdict,
        'borderline': verdict != LITTLE and (near(p, P_MAX, closed_low=False) or near(ratio, RATIO_MIN)),
        'depth_median': st.median(depths) if depths else None,
        'perms': perms,
        'seed': seed,
    }


def overall(verdicts):
    if YES in verdicts:
        return YES
    if NO in verdicts:
        return NO
    return LITTLE
