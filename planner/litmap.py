"""Weekly literature map (docs/LITMAP_SPEC.md): where the papers added to Zotero landed in the library, how much of each
one the library already covered, and the closest pair of passages, quoted. Standard library only.

One shared 3-D layout (MDS with Sammon weighting over centred paper vectors) is stored in <data>/litmap/layout.json and
kept from week to week: only new papers are placed. Novelty uses one-directional Chamfer over chunk vectors; quoted
passages are chosen by the pplx service's MaxSim when it serves the index that was read, else by chunk vectors.
"""
import array
import json
import math
import re
from bisect import bisect_right
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from operator import mul
from pathlib import Path
from xml.sax.saxutils import escape

from . import config, pplx, store, zotlib

LIGHT = ("#104281", "#2a78d6", "#86b6ef")   # this week, 1 week ago, 2 weeks ago (validated ordinal ramp)
DARK = ("#9ec5f4", "#3987e5", "#184f95")
DEFAULTS = {"enabled": False, "folder": "Literature maps", "weeks": 3}
CANDIDATES = 40       # earlier papers compared chunk by chunk, chosen by paper-vector cosine
LABELS = 12           # this week's papers labelled by name on the map; the rest get their number
EPOCH_REMOVED = 0.10  # more than this share of mapped papers gone: lay everything out again
AUTO = object()

dot = getattr(math, "sumprod", None) or (lambda a, b: sum(map(mul, a, b)))   # math.sumprod: Python 3.12+


def _unit(v: list[float]) -> list[float]:
    n = math.sqrt(dot(v, v))
    return [x / n for x in v] if n else list(v)


def _centred(vecs: list[list[float]]) -> list[list[float]]:
    mean = [sum(col) / len(vecs) for col in zip(*vecs)]
    return [_unit([a - b for a, b in zip(v, mean)]) for v in vecs]


# ---------------------------------------------------------------- junk

_YEAR = re.compile(r"\b(?:19|20)\d\d\b")
_BOILER = re.compile(r"creative commons|licen[cs]e|copyright|rights reserved|competing interest|acknowledg|funding|"
                     r"author contributions|data availability|correspondence", re.I)
_INITIALS = re.compile(r"\b[A-Z]\.(?:\s?[A-Z]\.)?")
_FORM = re.compile(r"reporting summary|checklist", re.I)
_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")


def is_junk(text: str) -> bool:
    """Reference lists, author lists, checklists, boilerplate, tables and garbled PDF text: never quoted, and left out
    of novelty (they match each other across unrelated papers)."""
    if _CONTROL.search(text):
        return True
    chars = [c for c in text if not c.isspace()]
    if not chars or sum(c.isalpha() for c in chars) < 0.6 * len(chars):
        return True
    return (len(_YEAR.findall(text)) >= 8 or len(_INITIALS.findall(text)) >= 15 or bool(_BOILER.search(text))
            or bool(_FORM.search(text)))


# ---------------------------------------------------------------- the library

@dataclass
class Paper:
    key: str
    citekey: str
    title: str
    authors: list
    year: int | None
    chunks: list[int]   # indices into Library.chunk_*


@dataclass
class Library:
    model: str
    content_hash: str | None
    papers: list[Paper]
    chunk_vec: list[list[float]]   # centred, unit length
    chunk_row: list[int]           # the chunk's row in vectors.f32 (what the pplx service scores)
    chunk_text: list[str]
    chunk_page: list[int]
    chunk_junk: list[bool]
    paper_vec: list[list[float]]   # centred, unit length
    no_chunks: int = 0
    no_date: int = 0


def load_library(index_dir: Path, dates: dict | None = None) -> Library:
    """The live paper index as vectors. A chunk's vector is the row its record names (abstract rows sit between
    papers' chunks, so list positions are not rows). Papers without chunk vectors, or without a date when `dates` is
    given, are skipped and counted."""
    manifest = json.loads((index_dir / "manifest.json").read_text())
    dims = int(manifest["dims"])
    papers = json.loads((index_dir / "papers.json").read_text())
    chunks = json.loads((index_dir / "chunks.json").read_text())
    raw = array.array("f")
    raw.frombytes((index_dir / "vectors.f32").read_bytes())
    by_paper: dict[int, list[dict]] = {}
    for c in chunks:
        if c.get("row") is not None:
            by_paper.setdefault(c["paper"], []).append(c)
    lib = Library(manifest.get("model", ""), manifest.get("content_hash"), [], [], [], [], [], [], [])
    unit_raw: list[list[float]] = []
    for i, p in enumerate(papers):
        cs = by_paper.get(i)
        if not cs:
            lib.no_chunks += 1
            continue
        if dates is not None and p["key"] not in dates:
            lib.no_date += 1
            continue
        idx = []
        for c in cs:
            r = c["row"]
            idx.append(len(lib.chunk_row))
            lib.chunk_row.append(r)
            lib.chunk_text.append(c.get("text") or "")
            lib.chunk_page.append(int(c.get("page") or 0))
            unit_raw.append(_unit(raw[r * dims:(r + 1) * dims].tolist()))
        lib.papers.append(Paper(p["key"], p.get("citekey") or p["key"], p.get("title") or p["key"],
                                list(p.get("authors") or []), p.get("year"), idx))
    if not lib.papers:
        return lib
    lib.chunk_vec = _centred(unit_raw)
    lib.chunk_junk = [is_junk(t) for t in lib.chunk_text]
    means = [_unit([sum(col) / len(p.chunks) for col in zip(*(unit_raw[c] for c in p.chunks))]) for p in lib.papers]
    lib.paper_vec = _centred(means)
    return lib


def zotero_dates(zotero_dir: Path) -> dict[str, str]:
    """Zotero item key → dateAdded (UTC, 'YYYY-MM-DD HH:MM:SS'), read from a private snapshot of the database."""
    with zotlib.open_snapshot(zotero_dir) as conn:
        return {k: d for k, d in conn.execute("SELECT key, dateAdded FROM items") if d}


# ---------------------------------------------------------------- weeks

def week_of(d: date) -> str:
    y, w, _ = d.isocalendar()
    return f"{y}-W{w:02d}"


def local_week(date_added: str) -> str:
    """The local ISO week of a Zotero dateAdded (stored in UTC)."""
    t = datetime.fromisoformat(date_added.replace(" ", "T")).replace(tzinfo=timezone.utc).astimezone()
    return week_of(t)


def week_monday(week: str) -> date:
    y, w = week.split("-W")
    return date.fromisocalendar(int(y), int(w), 1)


def week_range(week: str) -> tuple[str, str]:
    mon = week_monday(week)
    return mon.isoformat(), (mon + timedelta(days=6)).isoformat()


def previous_week(week: str) -> str:
    return week_of(week_monday(week) - timedelta(days=7))


def last_complete_week(now: datetime) -> str:
    return previous_week(week_of(now))


def week_label(week: str) -> str:
    """'12–18 Oct', or '28 Sep – 4 Oct' across months."""
    a = week_monday(week)
    b = a + timedelta(days=6)
    if a.month == b.month:
        return f"{a.day}–{b.day} {b:%b}"
    return f"{a.day} {a:%b} – {b.day} {b:%b}"


def week_ages(weeks: dict, target: str, n: int) -> dict:
    """Each paper's age in weeks within the window ending at `target` (0 = that week), or None outside it."""
    window = [target]
    while len(window) < n:
        window.append(previous_week(window[-1]))
    return {k: (window.index(w) if w in window else None) for k, w in weeks.items()}


# ---------------------------------------------------------------- novelty

@dataclass
class Novelty:
    nearest: int            # the earlier paper that covers this one best
    nearest_cover: float    # mean over this paper's chunks of their best cosine with the nearest paper's chunks
    library_cover: float    # the same against every candidate paper at once
    novelty: float          # 1 − library_cover
    recombination: float    # library_cover − nearest_cover: covered by the library, not by any one paper
    percentile: float = 0.0  # share of all novelty values at or below this one


def _content(lib: Library, p: int) -> list[int]:
    cs = [c for c in lib.papers[p].chunks if not lib.chunk_junk[c]]
    return cs or lib.papers[p].chunks


def novelty(lib: Library, weeks: list[str]) -> list[Novelty | None]:
    """For every paper, against the papers added before its week started (None in the first week)."""
    n = len(lib.papers)
    pv, cv = lib.paper_vec, lib.chunk_vec
    content = [_content(lib, p) for p in range(n)]
    out: list[Novelty | None] = [None] * n
    for p in range(n):
        earlier = [q for q in range(n) if weeks[q] < weeks[p]]
        if not earlier:
            continue
        cands = sorted(earlier, key=lambda q: (-dot(pv[p], pv[q]), q))[:CANDIDATES]
        best = [-2.0] * len(content[p])
        covers = {}
        for q in cands:
            total = 0.0
            for i, c in enumerate(content[p]):
                vc = cv[c]
                m = max(dot(vc, cv[d]) for d in content[q])
                total += m
                if m > best[i]:
                    best[i] = m
            covers[q] = total / len(content[p])
        nearest = min(covers, key=lambda q: (-covers[q], q))
        lib_cover = sum(best) / len(best)
        out[p] = Novelty(nearest, covers[nearest], lib_cover, 1 - lib_cover, lib_cover - covers[nearest])
    values = sorted(o.novelty for o in out if o)
    for o in out:
        if o:
            o.percentile = bisect_right(values, o.novelty) / len(values)
    return out


# ---------------------------------------------------------------- quoted passages

@dataclass
class Passage:
    chunk_p: int
    chunk_q: int
    method: str     # "MaxSim" or "chunk vectors"
    score: float


def passage(lib: Library, p: int, q: int, scorer=None, k: int = 3) -> Passage | None:
    """The closest pair of passages between paper p and paper q, junk excluded. The k best pairs by chunk-vector cosine
    (distinct chunks of p) are candidates; with a scorer whose index matches, each candidate chunk of p is scored against
    every row by MaxSim and the best chunk of q wins."""
    cp = [c for c in lib.papers[p].chunks if not lib.chunk_junk[c]]
    cq = [c for c in lib.papers[q].chunks if not lib.chunk_junk[c]]
    if not cp or not cq:
        return None
    cv = lib.chunk_vec
    pairs = sorted(((dot(cv[c], cv[d]), c, d) for c in cp for d in cq), key=lambda t: (-t[0], t[1], t[2]))
    picked, seen = [], set()
    for s, c, d in pairs:
        if c not in seen:
            seen.add(c)
            picked.append((s, c, d))
            if len(picked) == k:
                break
    fallback = Passage(picked[0][1], picked[0][2], "chunk vectors", picked[0][0])
    if scorer is None:
        return fallback
    top = None
    for _, c, _ in picked:
        try:
            res = scorer(lib.chunk_text[c])
        except (OSError, ValueError, KeyError):
            res = None
        if not res or res.get("content_hash") != lib.content_hash:
            return fallback
        sc = res["scores"]
        d = max(cq, key=lambda d: (sc[lib.chunk_row[d]] if lib.chunk_row[d] < len(sc) else float("-inf"), -d))
        if lib.chunk_row[d] >= len(sc):
            return fallback
        if top is None or sc[lib.chunk_row[d]] > top.score:
            top = Passage(c, d, "MaxSim", sc[lib.chunk_row[d]])
    return top


# ---------------------------------------------------------------- layout

def distances(vecs: list[list[float]]) -> list[list[float]]:
    n = len(vecs)
    D = [[0.0] * n for _ in range(n)]
    for i in range(n):
        for j in range(i + 1, n):
            D[i][j] = D[j][i] = max(0.0, 1.0 - dot(vecs[i], vecs[j]))
    return D


def _eig_top(C: list[list[float]], k: int, iters: int = 200) -> list[list[float]]:
    """Top-k eigenvectors of a symmetric matrix by power iteration with deflation; deterministic start and sign (the
    largest component is positive)."""
    m = len(C)
    C = [list(r) for r in C]
    out = []
    for _ in range(k):
        v = _unit([1.0 / (i + 1) for i in range(m)])
        for _ in range(iters):
            w = [dot(r, v) for r in C]
            if not any(w):
                break
            v = _unit(w)
        big = max(range(m), key=lambda i: (abs(v[i]), -i))
        if v[big] < 0:
            v = [-x for x in v]
        lam = dot(v, [dot(r, v) for r in C])
        C = [[C[i][j] - lam * v[i] * v[j] for j in range(m)] for i in range(m)]
        out.append(v)
    return out


def _median(xs: list[float]) -> float:
    s = sorted(xs)
    return s[len(s) // 2] if s else 0.0


def _offdiag(M: list[list[float]]) -> list[float]:
    return [M[i][j] for i in range(len(M)) for j in range(i + 1, len(M))]


def pca_start(vecs: list[list[float]], D: list[list[float]], d: int = 3) -> list[list[float]]:
    """The first d principal components of the vectors, scaled so their median pairwise distance matches D's."""
    n = len(vecs)
    if n < 2:
        return [[0.0] * d for _ in range(n)]
    mean = [sum(col) / n for col in zip(*vecs)]
    X = [[a - b for a, b in zip(v, mean)] for v in vecs]
    cols = list(zip(*X))
    C = [[dot(cols[a], cols[b]) for b in range(len(cols))] for a in range(len(cols))]
    axes = _eig_top(C, d)
    Y = [[dot(x, ax) for ax in axes] for x in X]
    E = _median([math.dist(Y[i], Y[j]) for i in range(n) for j in range(i + 1, n)])
    s = _median(_offdiag(D)) / E if E else 1.0
    return [[s * c for c in y] for y in Y]


def _sammon_weights(D):
    n = len(D)
    return [[0.0 if i == j else 1.0 / max(D[i][j], 1e-3) for j in range(n)] for i in range(n)]


def _invert(A: list[list[float]]) -> list[list[float]]:
    """Gauss–Jordan with partial pivoting, in double precision."""
    n = len(A)
    M = [list(r) + [1.0 if i == j else 0.0 for j in range(n)] for i, r in enumerate(A)]
    for k in range(n):
        piv = max(range(k, n), key=lambda i: abs(M[i][k]))
        M[k], M[piv] = M[piv], M[k]
        pk = M[k][k]
        rk = [x / pk for x in M[k]]
        M[k] = rk
        for i in range(n):
            if i != k:
                f = M[i][k]
                if f:
                    M[i] = [a - f * b for a, b in zip(M[i], rk)]
    return [r[n:] for r in M]


def smacof(D: list[list[float]], Y: list[list[float]], iters: int = 300) -> list[list[float]]:
    """Metric MDS with Sammon weights (1/distance), fitted by repeated Guttman transforms. The weighted Laplacian's
    pseudo-inverse is (V + 11ᵀ/n)⁻¹ − 11ᵀ/n."""
    n = len(D)
    if n < 3:
        return [list(y) for y in Y]
    W = _sammon_weights(D)
    V = [[-W[i][j] for j in range(n)] for i in range(n)]
    for i in range(n):
        V[i][i] = sum(W[i])
    inv = _invert([[V[i][j] + 1.0 / n for j in range(n)] for i in range(n)])
    Vp = [[x - 1.0 / n for x in r] for r in inv]
    Y = [list(y) for y in Y]
    for _ in range(iters):
        cols = list(zip(*Y))
        BY = []
        for i in range(n):
            Yi, Wi, Di = Y[i], W[i], D[i]
            row = [0.0] * n
            s = 0.0
            for j in range(n):
                if j != i:
                    e = math.dist(Yi, Y[j])
                    b = -Wi[j] * Di[j] / e if e > 1e-12 else 0.0
                    row[j] = b
                    s += b
            row[i] = -s
            BY.append([dot(row, c) for c in cols])
        bcols = list(zip(*BY))
        Y = [[dot(Vp[i], c) for c in bcols] for i in range(n)]
    return Y


def place(D: list[list[float]], Y: list, new: list[int], iters: int = 200) -> None:
    """Move only the points in `new` to lower their weighted stress against all other points (in place)."""
    n = len(D)
    for _ in range(iters):
        for i in new:
            num = [0.0, 0.0, 0.0]
            den = 0.0
            Yi = Y[i]
            for j in range(n):
                if j == i:
                    continue
                w = 1.0 / max(D[i][j], 1e-3)
                e = math.dist(Yi, Y[j]) or 1e-12
                r = D[i][j] / e
                Yj = Y[j]
                for k in range(3):
                    num[k] += w * (Yj[k] + r * (Yi[k] - Yj[k]))
                den += w
            Y[i] = [x / den for x in num]


def stress(D: list[list[float]], Y: list[list[float]]) -> float:
    """Sammon-weighted stress: the sum over pairs of (real distance − map distance)² / real distance."""
    n = len(D)
    return sum((D[i][j] - math.dist(Y[i], Y[j])) ** 2 / max(D[i][j], 1e-3)
               for i in range(n) for j in range(i + 1, n))


def _ranks(xs: list[float]) -> list[float]:
    order = sorted(range(len(xs)), key=lambda i: xs[i])
    r = [0.0] * len(xs)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and xs[order[j + 1]] == xs[order[i]]:
            j += 1
        for k in range(i, j + 1):
            r[order[k]] = (i + j) / 2
        i = j + 1
    return r


def _pearson(a: list[float], b: list[float]) -> float:
    ma, mb = sum(a) / len(a), sum(b) / len(b)
    da, db = [x - ma for x in a], [x - mb for x in b]
    den = math.sqrt(dot(da, da) * dot(db, db))
    return dot(da, db) / den if den else 0.0


def layout_scores(D: list[list[float]], Y: list[list[float]]) -> tuple[float, float]:
    """(global, local): rank correlation of all pairwise distances, and the share of each point's 10 nearest
    neighbours kept on the map."""
    n = len(D)
    if n < 3:
        return 1.0, 1.0
    E = [[math.dist(Y[i], Y[j]) for j in range(n)] for i in range(n)]
    g = _pearson(_ranks(_offdiag(D)), _ranks(_offdiag(E)))
    k = min(10, n - 1)
    kept = 0
    for i in range(n):
        others = [j for j in range(n) if j != i]
        a = set(sorted(others, key=lambda j: (D[i][j], j))[:k])
        b = set(sorted(others, key=lambda j: (E[i][j], j))[:k])
        kept += len(a & b)
    return round(g, 4), round(kept / (n * k), 4)


def epoch_reason(stored: dict | None, model: str, keys: list[str], relayout: bool) -> str | None:
    """Why the layout must be rebuilt from scratch, or None to keep stored points where they are."""
    if not stored or not stored.get("coords"):
        return "first run"
    if relayout:
        return "asked for (--relayout)"
    if stored.get("model") != model:
        return "model changed"
    have = set(keys)
    gone = sum(1 for k in stored["coords"] if k not in have)
    share = gone / len(stored["coords"])
    if share > EPOCH_REMOVED:
        return f"{share:.0%} of mapped papers removed"
    return None


def build_layout(lib: Library, stored: dict | None, relayout: bool, now: datetime) -> tuple[dict, list, str | None]:
    """The layout for every paper in `lib`: (layout.json contents, coordinates by paper index, why a new epoch began
    or None)."""
    keys = [p.key for p in lib.papers]
    D = distances(lib.paper_vec)
    reason = epoch_reason(stored, lib.model, keys, relayout)
    if reason:
        Y = smacof(D, pca_start(lib.paper_vec, D))
        Y = [[round(c, 6) for c in y] for y in Y]
        scores = layout_scores(D, Y)
        epoch = {"epoch": (stored or {}).get("epoch", 0) + 1, "started": now.isoformat(timespec="seconds"),
                 "scores": list(scores)}
    else:
        coords = stored["coords"]
        Y = [coords.get(k) for k in keys]
        new = [i for i, y in enumerate(Y) if y is None]
        placed = [i for i, y in enumerate(Y) if y is not None]
        for i in new:
            near = sorted(placed, key=lambda j: (-dot(lib.paper_vec[i], lib.paper_vec[j]), j))[:5]
            w = [max(dot(lib.paper_vec[i], lib.paper_vec[j]), 0.0) + 1e-6 for j in near]
            Y[i] = [sum(wj * Y[j][k] for wj, j in zip(w, near)) / sum(w) for k in range(3)]
        place(D, Y, new)
        for i in new:
            Y[i] = [round(c, 6) for c in Y[i]]
        epoch = {k: stored[k] for k in ("epoch", "started", "scores")}
    layout = {"model": lib.model, **epoch, "updated": now.isoformat(timespec="seconds"),
              "coords": {k: y for k, y in zip(keys, Y)}}
    return layout, Y, reason


# ---------------------------------------------------------------- picture

def _camera(Y: list[list[float]]) -> list[list[float]]:
    """Axes to draw along: the two of widest spread across the screen, the narrowest as depth."""
    n = len(Y)
    mean = [sum(c) / n for c in zip(*Y)]
    X = [[a - b for a, b in zip(y, mean)] for y in Y]
    C = [[sum(x[a] * x[b] for x in X) for b in range(3)] for a in range(3)]
    a1, a2 = _eig_top(C, 2)
    a3 = [a1[1] * a2[2] - a1[2] * a2[1], a1[2] * a2[0] - a1[0] * a2[2], a1[0] * a2[1] - a1[1] * a2[0]]
    return [[dot(x, a1), dot(x, a2), dot(x, a3)] for x in X]


def _short(p: Paper) -> str:
    """'FirstAuthor Year'; for a paper with no authors (web articles), the start of its title."""
    if p.authors:
        first = p.authors[0].split(",")[0].strip()
    else:
        first = p.title if len(p.title) <= 24 else p.title[:22].rsplit(" ", 1)[0] + "…"
    return f"{first} {p.year}" if p.year else first


W_SVG, H_SVG, PAD, TOP = 960, 640, 40, 96


def render_svg(lib: Library, Y: list, shown: list[int], ages: dict, numbered: list[int], nov: list,
               target: str, window: list[str], counts: dict) -> str:
    """The map: every paper you had by the end of `target`, the window's weeks coloured by age, this week's papers
    labelled and joined to their nearest earlier paper."""
    P = _camera([Y[i] for i in shown]) if len(shown) > 1 else [[0.0, 0.0, 0.0] for _ in shown]
    pos = dict(zip(shown, P))
    xs = [p[0] for p in P] or [0.0]
    ys = [p[1] for p in P] or [0.0]
    zs = [p[2] for p in P] or [0.0]
    span = max(max(xs) - min(xs), max(ys) - min(ys)) or 1.0
    s = min(W_SVG - 2 * PAD - 160, H_SVG - TOP - PAD) / span
    cx = PAD + 80 + (W_SVG - 2 * PAD - 160) / 2
    cy = TOP + (H_SVG - TOP - PAD) / 2
    zlo, zhi = min(zs), max(zs)

    def xy(i):
        x, y, _ = pos[i]
        return cx + (x - (max(xs) + min(xs)) / 2) * s, cy - (y - (max(ys) + min(ys)) / 2) * s

    def depth(i):   # 0 far … 1 near
        return (pos[i][2] - zlo) / (zhi - zlo) if zhi > zlo else 0.5

    css = ".bg{fill:#fcfcfb}.ink{fill:#0b0b0b}.muted{fill:#52514e}.lib{fill:#52514e}"
    css += "".join(f".a{a}{{fill:{c}}}" for a, c in enumerate(LIGHT)) + f".nearest{{stroke:{LIGHT[0]}}}"
    css += ".dot{stroke:#fcfcfb;stroke-width:1}"
    dark = ".bg{fill:#1a1a19}.ink{fill:#f0efec}.muted{fill:#c3c2b7}.lib{fill:#c3c2b7}"
    dark += "".join(f".a{a}{{fill:{c}}}" for a, c in enumerate(DARK)) + f".nearest{{stroke:{DARK[0]}}}"
    dark += ".dot{stroke:#1a1a19}"
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W_SVG} {H_SVG}" width="{W_SVG}" height="{H_SVG}" '
           'font-family="-apple-system, system-ui, Helvetica, Arial, sans-serif" font-size="12">',
           f"<title>Literature map, {target}</title>",
           f"<style>{css}@media (prefers-color-scheme: dark){{{dark}}}</style>",
           f'<rect class="bg" width="{W_SVG}" height="{H_SVG}" rx="8"/>',
           f'<text class="ink" x="{PAD}" y="34" font-size="16" font-weight="600">Literature map · week '
           f'{int(target.split("-W")[1])}, {target.split("-W")[0]}</text>',
           f'<text class="muted" x="{PAD}" y="54">{len(shown)} papers by the end of the week. Distances in 3-D, seen '
           f'along the axis of least spread; nearer dots are larger.</text>']
    x = PAD
    for a, w in enumerate(window):
        text = f'{week_label(w)} · {counts.get(w, 0)} added{" (this week)" if a == 0 else ""}'
        out.append(f'<circle class="a{a}" cx="{x + 6}" cy="76" r="{5 if a == 0 else 4}"/>')
        out.append(f'<text class="ink legend" x="{x + 16}" y="80">{escape(text)}</text>')
        x += 16 + 6.6 * len(text) + 28
    lib_dots = sorted((i for i in shown if ages.get(i) is None), key=depth)
    for i in lib_dots:
        x, y = xy(i)
        d = depth(i)
        out.append(f'<circle class="lib" cx="{x:.1f}" cy="{y:.1f}" r="{1.6 + 1.6 * d:.1f}" '
                   f'fill-opacity="{0.25 + 0.3 * d:.2f}"/>')
    for i in numbered:
        if nov[i] is not None and nov[i].nearest in pos:
            (x1, y1), (x2, y2) = xy(i), xy(nov[i].nearest)
            out.append(f'<line class="nearest" x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" '
                       'stroke-width="1.5" stroke-opacity="0.55"/>')
    for a in (2, 1, 0):
        for i in sorted((i for i in shown if ages.get(i) == a), key=depth):
            x, y = xy(i)
            r = (5.0 if a == 0 else 3.6) + 1.2 * depth(i)
            out.append(f'<circle class="a{a} dot" cx="{x:.1f}" cy="{y:.1f}" r="{r:.1f}"/>')
    boxes: list[tuple[float, float, float, float]] = []
    for num, i in enumerate(numbered, 1):
        x, y = xy(i)
        label = _short(lib.papers[i]) if num <= LABELS else str(num)
        w = 6.6 * len(label)
        spot = None
        for dy in (0, -14, 14, -28, 28, -42, 42):
            for dx in (8, -8 - w):
                if not PAD / 2 <= x + dx <= W_SVG - PAD / 2 - w:
                    continue
                b = (x + dx, y + dy - 10, x + dx + w, y + dy + 3)
                if not any(b[0] < o[2] and o[0] < b[2] and b[1] < o[3] and o[1] < b[3] for o in boxes):
                    spot = b
                    break
            if spot:
                break
        spot = spot or (x + 8, y - 10, x + 8 + w, y + 3)
        boxes.append(spot)
        out.append(f'<text class="ink label" x="{spot[0]:.1f}" y="{spot[3] - 3:.1f}">{escape(label)}</text>')
    out.append("</svg>")
    return "\n".join(out) + "\n"


# ---------------------------------------------------------------- note

_WORD = re.compile(r"[a-z][a-z-]{3,}")
_STOP = set("this that with from were have which their these those been also than into over such each when where "
            "while there they them then more most only both between using used within about after before other "
            "however because under here what will would could should shows show shown".split())
_SENTENCE = re.compile(r"(?<=[.!?])\s+")


def _words(text: str) -> set[str]:
    return {w for w in _WORD.findall(text.lower()) if w not in _STOP}


def _quote(text: str, other: str, limit: int = 320) -> str:
    """The run of whole sentences (up to `limit` characters) sharing the most words with the other passage."""
    sents = _SENTENCE.split(" ".join(text.split()))
    theirs = _words(other)
    best, best_score = "", -1
    for i in range(len(sents)):
        window = sents[i]
        for s in sents[i + 1:]:
            if len(window) + 1 + len(s) > limit:
                break
            window += " " + s
        score = len(_words(window[:limit]) & theirs)
        if score > best_score:
            best, best_score = ("… " if i else "") + window, score
    if len(best) > limit:
        best = best[:limit].rsplit(" ", 1)[0] + " …"
    return best.replace("[[", "[ [")


def _page(page: int) -> str:
    return f", p. {page}" if page else ""   # web snapshots have no pages


def week_stats(lib: Library, weeks: list[str], nov: list, week: str) -> tuple[float | None, float | None]:
    """(spread, mean novelty) for one week: the mean pairwise cosine among its papers (centred vectors, so 0 is as alike
    as two random papers of the library), and the mean novelty of those that had earlier papers."""
    mine = [i for i, w in enumerate(weeks) if w == week]
    pv = lib.paper_vec
    spread = None
    if len(mine) > 1:
        pairs = [dot(pv[a], pv[b]) for x, a in enumerate(mine) for b in mine[x + 1:]]
        spread = sum(pairs) / len(pairs)
    vals = [nov[i].novelty for i in mine if nov[i]]
    return spread, (sum(vals) / len(vals) if vals else None)


def _fmt(x: float | None) -> str:
    return "–" if x is None else f"{x:.2f}"


def render_note(lib: Library, numbered: list[int], nov: list, passages: dict, weeks: list[str], target: str,
                window: list[str], counts: dict, layout: dict, now_scores: tuple, svg_name: str, skipped: dict) -> str:
    out = [f"# Literature map · {target} ({week_label(target)})", "", f"![[{svg_name}]]", ""]
    n = len(numbered)
    out.append(f"{n} paper{'s' if n != 1 else ''} added this week." if n else "No papers added this week.")
    out.append("")
    if numbered:
        out += ["## Added this week", "",
                "*Novelty* is how little of a paper your earlier papers covered (1 − the mean of each passage's best "
                "match). *Recombination* is high when your library covered it but no single paper did.", ""]
    for num, i in enumerate(numbered, 1):
        p = lib.papers[i]
        out += [f"### {num}. {p.title} [[{p.citekey}]]", ""]
        v = nov[i]
        if v is None:
            out += ["- **Novelty:** no earlier papers to compare with.", ""]
            continue
        q = lib.papers[v.nearest]
        out += [f"- **Novelty:** {v.novelty:.2f}, more novel than {v.percentile:.0%} of your additions so far",
                f"- **Nearest earlier paper:** {q.title} [[{q.citekey}]] (covers {v.nearest_cover:.2f})",
                f"- **Recombination:** {v.recombination:.2f}", ""]
        pas = passages.get(i)
        if pas:
            tp, tq = lib.chunk_text[pas.chunk_p], lib.chunk_text[pas.chunk_q]
            out += [f"> **This paper{_page(lib.chunk_page[pas.chunk_p])}:** {_quote(tp, tq)}", "",
                    f"> **[[{q.citekey}]]{_page(lib.chunk_page[pas.chunk_q])}:** {_quote(tq, tp)}",
                    "", f"Passages chosen by {pas.method}.", ""]
    out += ["## The last weeks", "",
            "*Spread*: how alike the week's papers are (mean cosine; 0 is as alike as two random papers of yours). "
            "*Mean novelty*: the average novelty of the week's papers.", "",
            "| Week | Added | Spread | Mean novelty |", "|---|---|---|---|"]
    for a, w in enumerate(window):
        spread, mean_nov = week_stats(lib, weeks, nov, w)
        out.append(f"| {week_label(w)}{' (this week)' if a == 0 else ''} | {counts.get(w, 0)} | {_fmt(spread)} | "
                   f"{_fmt(mean_nov)} |")
    g0, l0 = layout["scores"]
    g, loc = now_scores
    out += ["", "## Layout", "",
            f"Epoch {layout['epoch']} (started {layout['started'][:10]}): MDS with Sammon weighting in 3-D over "
            f"centred paper vectors. Distances kept: global {g:.2f}, local {loc:.2f} (at the start of the epoch "
            f"{g0:.2f}, {l0:.2f})."]
    if g < g0 - 0.05 or loc < l0 - 0.05:
        out.append("The map has drifted from the real distances: run `planner litmap --relayout`.")
    if skipped.get("no chunks") or skipped.get("no date"):
        out.append(f"Not on the map: {skipped['no chunks']} papers without text, {skipped['no date']} without a date.")
    return "\n".join(out) + "\n"


# ---------------------------------------------------------------- the command

def _default_scorer(cfg):
    s = config.SearchSettings.of(cfg)
    if s.backend != "pplx" or pplx.health(s.pplx_url) is None:
        return None
    return lambda text: pplx.rowscores(text, s.pplx_url)


def run(cfg, week: str | None = None, weeks: int | None = None, relayout: bool = False, dry_run: bool = False,
        out: Path | None = None, dates: dict | None = None, scorer=AUTO, now: datetime | None = None) -> dict:
    """`planner litmap`. Writes <folder>/<week>.md and .svg in the vault and <data>/litmap/layout.json, or all three
    into `out`. Returns {"message", ...}; never raises for a disabled or busy map."""
    settings = {**DEFAULTS, **(getattr(cfg, "litmap", None) or {})}
    if not settings["enabled"] and out is None:
        return {"message": "litmap is not enabled: add [litmap] enabled = true to config.local.toml, "
                           "or pass --out DIR to write somewhere else"}
    try:
        with store.named_lock(cfg, "litmap.lock", blocking=False):
            return _run(cfg, settings, week, weeks, relayout, dry_run, out, dates, scorer, now)
    except BlockingIOError:
        return {"message": "litmap: busy (another run holds the lock)"}


def _run(cfg, settings, week, n_weeks, relayout, dry_run, out, dates, scorer, now) -> dict:
    now = now or datetime.now()
    target = week or last_complete_week(now)
    n_weeks = int(n_weeks or settings["weeks"])
    if dates is None:
        dates = zotero_dates(config.SearchSettings.of(cfg).zotero_dir)
    lib = load_library(cfg.data_dir / "search", dates)
    skipped = {"no chunks": lib.no_chunks, "no date": lib.no_date}
    if not lib.papers:
        return {"message": "litmap: no papers with text and a date in the index", "skipped": skipped}
    weeks = [local_week(dates[p.key]) for p in lib.papers]
    ages_by_key = week_ages({p.key: w for p, w in zip(lib.papers, weeks)}, target, n_weeks)
    ages = {i: ages_by_key[p.key] for i, p in enumerate(lib.papers)}
    window = [target]
    while len(window) < n_weeks:
        window.append(previous_week(window[-1]))
    counts = {w: sum(1 for x in weeks if x == w) for w in window}

    nov = novelty(lib, weeks)
    this_week = [i for i, w in enumerate(weeks) if w == target]
    numbered = sorted(this_week, key=lambda i: (-(nov[i].novelty if nov[i] else -1.0), lib.papers[i].title, i))
    if scorer is AUTO:
        scorer = _default_scorer(cfg)
    passages = {i: passage(lib, i, nov[i].nearest, scorer) for i in numbered if nov[i]}

    layout_path = (out / "layout.json") if out else cfg.data_dir / "litmap" / "layout.json"
    stored = store.load_json(layout_path)
    layout, Y, reason = build_layout(lib, stored, relayout, now)
    shown = [i for i, w in enumerate(weeks) if w <= target]
    D = distances(lib.paper_vec)
    now_scores = layout_scores(D, Y)

    summary = []
    for num, i in enumerate(numbered, 1):
        v = nov[i]
        line = f"{num}. {lib.papers[i].title}"
        if v:
            line += (f" — novelty {v.novelty:.2f} ({v.percentile:.0%}), nearest {lib.papers[v.nearest].title} "
                     f"({v.nearest_cover:.2f}), recombination {v.recombination:.2f}")
        summary.append(line)
    res = {"week": target, "added": len(this_week), "skipped": skipped, "new_epoch": reason is not None,
           "epoch_reason": reason, "summary": "\n".join(summary), "files": []}
    if dry_run:
        res["message"] = f"litmap {target}: {len(this_week)} added (dry run, nothing written)"
        return res

    svg_name = f"{target}.svg"
    svg = render_svg(lib, Y, shown, ages, numbered, nov, target, window, counts)
    note = render_note(lib, numbered, nov, passages, weeks, target, window, counts, layout, now_scores, svg_name,
                       skipped)
    folder = out or (cfg.vault / settings["folder"])
    store.write_text(folder / svg_name, svg)
    store.write_text(folder / f"{target}.md", note)
    store.write_json(layout_path, layout)
    res["files"] = [str(folder / f"{target}.md"), str(folder / svg_name), str(layout_path)]
    res["message"] = (f"litmap {target}: {len(this_week)} added; wrote {folder / f'{target}.md'}"
                      + (f" (new layout: {reason})" if reason else ""))
    return res
