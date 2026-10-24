"""Writes parity_texts.json: synthetic passages and queries for the GGUF parity check (no real library content).

Paragraphs are written for this file. Documents are single paragraphs, concatenations of 2-5 of them (300-900 words,
the size of a paper chunk or a long note section) and edge cases. Deterministic: rerunning gives the same file.
usage: python3 -I make_parity_texts.py <out.json>
"""
import json
import random
import sys

P = [
    "Hydrogels whose stress relaxes quickly let encapsulated cells spread, proliferate and remodel their surroundings, "
    "whereas elastic gels of the same initial stiffness keep cells rounded. The effect depends on the timescale of "
    "relaxation relative to the time a cell takes to pull on its matrix.",
    "We measured the viscoelastic moduli of alginate networks crosslinked with calcium at four molecular weights. "
    "Lower molecular weight chains relaxed stress faster, and adding short polyethylene glycol spacers widened the "
    "accessible range without changing the elastic modulus.",
    "Patient-derived organoids reproduce many features of the tumour they came from, including drug response, but "
    "the reconstituted basement membrane they grow in varies from batch to batch and is poorly defined chemically.",
    "Mitochondria can move between cells through tunnelling nanotubes and extracellular vesicles. Cancer cells that "
    "acquire mitochondria from neighbouring immune cells gain oxidative capacity, while the donor cells lose function.",
    "Bayesian optimisation proposes the next experiment by balancing the predicted value of a formulation against the "
    "uncertainty of the surrogate model. With a Gaussian process and expected improvement, twenty rounds were enough "
    "to find adhesives stronger than any in the training set.",
    "Bacteriophages inject their genome through the cell envelope in seconds. A membrane-anchored nuclease that sits "
    "near the injection site can cut the incoming DNA before it is protected by phage proteins.",
    "The protein folds through a transition state in which a few native contacts have already formed; mutating those "
    "residues slows folding without changing stability, consistent with a nucleation-condensation mechanism.",
    "Light-sheet microscopy images large cleared samples quickly, but scattering in dense tissue still blurs the "
    "sheet. Matching the refractive index of the medium to that of the tissue restores optical transparency.",
    "A synthetic gene circuit that couples growth to a quorum-sensing signal keeps two strains at a set ratio in "
    "co-culture: when one strain overgrows, the signal it produces slows its own division.",
    "Le module de conservation G' dépasse le module de perte G'' à basse fréquence, ce qui indique un comportement de "
    "solide viscoélastique; la fréquence de croisement donne le temps de relaxation caractéristique.",
    "For a Maxwell element, sigma(t) = sigma_0 * exp(-t / tau) with tau = eta / E; a standard linear solid adds a "
    "parallel spring so that sigma(inf) = E_inf * epsilon_0 > 0. Fitting both to the same relaxation curve "
    "distinguishes them by the plateau.",
    "Diffusing-wave spectroscopy tracks the mean squared displacement <Δr²(τ)> of embedded tracer particles; the "
    "generalised Stokes–Einstein relation converts it into G*(ω) over five decades of frequency.",
    "Notes from the seminar: imaging deep brain activity without implants -- ultrasound-triggered fluorophores? Ask "
    "about photobleaching, depth limit (~5 mm?), and whether the probes cross the blood-brain barrier.",
    "TODO: compare stiffness (kPa) vs. relaxation half-time (s) across the five gel recipes; plot on log axes; "
    "check whether the outlier at 12 kPa is the batch with old crosslinker!!",
    "Active learning chooses which material to synthesise next by asking where the model is least certain. Unlike "
    "random screening, it reached the target viscoelastic window in a third of the experiments.",
    "Supramolecular fibres assembled from benzene-1,3,5-tricarboxamide monomers form gels whose mechanics can be tuned "
    "by mixing monomers with different side chains, giving stress relaxation from seconds to hours.",
]

QUERIES = [
    "faster stress relaxation helps cells spread",
    "molecular weight controls alginate viscoelasticity",
    "organoids basement membrane batch variability",
    "mitochondria transferred from immune cells to tumour cells",
    "bayesian optimisation of adhesive hydrogels",
    "nuclease cuts phage DNA during injection",
    "native contacts in the folding transition state",
    "refractive index matching for optical clearing",
    "gene circuit keeps strain ratio constant",
    "module de conservation viscoélastique",
    "Maxwell model vs standard linear solid",
    "microrheology mean squared displacement",
    "imaging deep brain without implants",
    "stiffness vs relaxation half-time plot",
    "active learning for materials discovery",
    "supramolecular fibres tunable mechanics",
    "what makes a gel behave like a solid at low frequency",
    "ultrasound",
    "G' > G''",
    "How do cells sense the timescale on which their matrix relaxes stress, and does it matter more than stiffness?",
]


def main(out: str) -> None:
    rng = random.Random(7)
    docs = list(P)
    while len(docs) < 44:
        k = rng.randint(2, 5)
        docs.append(" ".join(rng.sample(P, k)))
    docs += [
        "",
        "viscoelasticity",
        "!!! ... ??? --- ;;; (([[{{}}]]))",
        "α-helix → β-sheet transition at 37 °C; ΔG = −12 kJ mol⁻¹; 日本語のテキスト; emoji 🧪🔬",
        "line one\n\nline two\n\n\tindented line three\r\nwindows line four",
        " ".join([P[0]] * 30),  # ~1300 words: longer than any real chunk, still under the 4096-token document limit
    ]
    json.dump({"documents": docs, "queries": QUERIES}, open(out, "w"), ensure_ascii=False, indent=0)
    print(f"{len(docs)} documents, {len(QUERIES)} queries -> {out}")


if __name__ == "__main__":
    main(sys.argv[1])
