# /// script
# requires-python = ">=3.12"
# dependencies = ["marimo", "polars", "altair"]
# ///
"""Hyperparameter optimizer for alisp files with @hp annotations."""

import marimo

__generated_with = "0.20.4"
app = marimo.App(width="full")


@app.cell
def _():
    import marimo as mo
    import polars as pl
    import altair as alt
    import argparse
    import itertools
    import os
    import re
    import subprocess
    import sys
    from typing import NamedTuple
    from collections import defaultdict

    return (
        NamedTuple,
        alt,
        argparse,
        itertools,
        mo,
        os,
        pl,
        re,
        subprocess,
        sys,
    )


@app.cell
def _(NamedTuple):
    class HyperParam(NamedTuple):
        name: str
        min_val: int
        max_val: int
        step: int
        line_index: int
        current_val: int = 0


    class JobResult(NamedTuple):
        combo: tuple
        seed: int
        score: int | None
        error: str | None


    class SensitivityRow(NamedTuple):
        name: str
        values: list[int]
        means: list[float]
        signal: float
        noise: float
        seed_noise: float
        interaction_noise: float

    return HyperParam, JobResult, SensitivityRow


@app.cell
def _(re):
    SCORE_RE = re.compile(r"Score:\s*(\d+)")
    ANNOTATION_RE = re.compile(
        r"^\s*;\s*@hp\s+min=(\d+)\s+max=(\d+)\s+step=(\d+)\s*$"
    )
    CONST_RE = re.compile(r"^(\s*\(const\s+(\w+)\s+)(-?\d+)(\s*\).*)$")
    return ANNOTATION_RE, CONST_RE, SCORE_RE


@app.cell
def _(ANNOTATION_RE, CONST_RE, HyperParam):
    def parse_annotations(path: str) -> tuple[list[str], list[HyperParam]]:
        """Parse @hp annotations and extract hyperparameters."""
        lines = open(path).readlines()
        params: list[HyperParam] = []
        pending_annotation = None
        for i, line in enumerate(lines):
            ann_match = ANNOTATION_RE.match(line)
            if ann_match:
                pending_annotation = ann_match
                continue
            if pending_annotation is not None and line.strip() != "":
                const_match = CONST_RE.match(line)
                if not const_match:
                    raise ValueError(
                        f"@hp annotation on line {i - 1} not followed by (const NAME val)"
                    )
                name = const_match.group(2)
                current_val = int(const_match.group(3))
                min_val = int(pending_annotation.group(1))
                max_val = int(pending_annotation.group(2))
                step = int(pending_annotation.group(3))
                params.append(HyperParam(name, min_val, max_val, step, i, current_val))
                pending_annotation = None
        if pending_annotation is not None:
            raise ValueError(
                "Trailing @hp annotation at end of file with no (const) following"
            )
        return lines, params

    return (parse_annotations,)


@app.cell
def _(itertools):
    import math as _math

    def count_search_space(params) -> int:
        """Count combinations without materializing them."""
        if not params:
            return 0
        return _math.prod(
            len(range(p.min_val, p.max_val + 1, p.step)) for p in params
        )

    def build_search_space(params) -> list[tuple]:
        """Generate all combinations of hyperparameter values."""
        return list(
            itertools.product(
                *[range(p.min_val, p.max_val + 1, p.step) for p in params]
            )
        )

    return build_search_space, count_search_space


@app.cell
def _(JobResult, SCORE_RE, subprocess):
    def run_one(
        combo: tuple,
        seed: int,
        param_names: list[str],
        filepath: str,
        project_root: str,
        map_filter: str | None,
        relax_ops: bool,
        pinned: list[tuple[str, int]] | None = None,
    ) -> JobResult:
        """Run a single parameter combination with a given seed."""
        cmd = ["argc", "test"]
        for name, val in zip(param_names, combo):
            cmd.extend(["-D", f"{name}={val}"])
        for name, val in (pinned or []):
            cmd.extend(["-D", f"{name}={val}"])
        cmd.extend(["-s", str(seed)])
        if map_filter:
            cmd.extend(["-m", map_filter])
        if relax_ops:
            cmd.extend(["-o", "1000"])
        cmd.append(filepath)

        result = subprocess.run(
            cmd, capture_output=True, text=True, cwd=project_root
        )
        if result.returncode != 0:
            return JobResult(
                combo, seed, None, result.stderr.strip() or result.stdout.strip()
            )

        match = SCORE_RE.search(result.stdout)
        if match:
            return JobResult(combo, seed, int(match.group(1)), None)
        return JobResult(combo, seed, None, "No score found in output")

    return (run_one,)


@app.cell
def _(run_one):
    def run_sweep(
        params,
        combos: list[tuple],
        seeds: list[int],
        filepath: str,
        project_root: str,
        map_filter: str | None,
        relax_ops: bool,
        jobs: int,
        print_fn=print,
        progress_bar=None,
        pinned_params: list[tuple[str, int]] | None = None,
    ) -> list:
        """Run all combinations and seeds in parallel, collecting results."""
        import concurrent.futures

        param_names = [p.name for p in params]
        all_jobs = [(combo, seed) for combo in combos for seed in seeds]
        results = []

        with concurrent.futures.ThreadPoolExecutor(max_workers=jobs) as pool:
            futures = {
                pool.submit(
                    run_one,
                    combo,
                    seed,
                    param_names,
                    filepath,
                    project_root,
                    map_filter,
                    relax_ops,
                    pinned_params,
                ): (combo, seed)
                for combo, seed in all_jobs
            }
            for future in concurrent.futures.as_completed(futures):
                job_result = future.result()
                results.append(job_result)
                score_str = (
                    str(job_result.score)
                    if job_result.score is not None
                    else "ERROR"
                )
                print_fn(
                    f"[{len(results)}/{len(all_jobs)}] combo={job_result.combo} seed={job_result.seed} -> {score_str}"
                )
                if progress_bar is not None:
                    progress_bar.update(
                        subtitle=f"combo={job_result.combo} seed={job_result.seed} → {score_str}",
                    )

        return results

    return (run_sweep,)


@app.function
def average_scores(results, params):
    """Average scores across seeds for each combo, ranked by score."""
    from collections import defaultdict

    scores_by_combo = defaultdict(list)
    for r in results:
        if r.score is not None:
            scores_by_combo[r.combo].append(r.score)
    ranked = [
        (combo, sum(scores) / len(scores))
        for combo, scores in scores_by_combo.items()
        if scores
    ]
    ranked.sort(key=lambda x: x[1], reverse=True)
    return ranked


@app.cell
def _(SensitivityRow):
    def compute_sensitivity(results, params):
        """Analyze per-parameter sensitivity to score variation.

        Decomposes noise into two components:
        - seed_noise: variance from running the same combo across different seeds
        - interaction_noise: variance from other parameters (after averaging out seeds)
        """
        from collections import defaultdict

        sensitivity_rows = []
        for param_idx, param in enumerate(params):
            scores_by_value = defaultdict(list)
            for result in results:
                if result.score is not None:
                    scores_by_value[result.combo[param_idx]].append(result.score)
            if not scores_by_value:
                continue
            values = sorted(scores_by_value.keys())
            means = [
                sum(scores_by_value[v]) / len(scores_by_value[v]) for v in values
            ]
            signal = max(means) - min(means) if means else 0.0

            # Compute total noise as mean range within each value (unchanged)
            noise_ranges = []
            for v in values:
                if len(scores_by_value[v]) > 1:
                    s = scores_by_value[v]
                    noise_ranges.append(max(s) - min(s))
            noise = sum(noise_ranges) / len(noise_ranges) if noise_ranges else 0.0

            # Group scores by combo to get per-combo means and seed ranges
            scores_by_combo = defaultdict(lambda: defaultdict(list))
            for result in results:
                if result.score is not None:
                    scores_by_combo[result.combo][result.seed].append(result.score)

            # Seed noise: for each combo, range across seeds, then average
            # This is the noise from running the same combo on different maps
            seed_noise_ranges = []
            for combo, seeds_dict in scores_by_combo.items():
                seed_means = [
                    sum(s) / len(s) for s in seeds_dict.values() if s
                ]
                if len(seed_means) > 1:
                    seed_noise_ranges.append(max(seed_means) - min(seed_means))
            seed_noise = (
                sum(seed_noise_ranges) / len(seed_noise_ranges)
                if seed_noise_ranges
                else 0.0
            )

            # Interaction noise: for each param value, range of combo means
            # This shows how much the other parameters affect the score
            interaction_ranges = []
            for v in values:
                # Find all combos where this param has value v
                combo_means = []
                for combo, seeds_dict in scores_by_combo.items():
                    if combo[param_idx] == v:
                        all_scores = [
                            s for sl in seeds_dict.values() for s in sl
                        ]
                        if all_scores:
                            combo_means.append(
                                sum(all_scores) / len(all_scores)
                            )
                if len(combo_means) > 1:
                    interaction_ranges.append(
                        max(combo_means) - min(combo_means)
                    )
            interaction_noise = (
                sum(interaction_ranges) / len(interaction_ranges)
                if interaction_ranges
                else 0.0
            )

            sensitivity_rows.append(
                SensitivityRow(
                    name=param.name,
                    values=values,
                    means=means,
                    signal=signal,
                    noise=noise,
                    seed_noise=seed_noise,
                    interaction_noise=interaction_noise,
                )
            )
        return sensitivity_rows

    return (compute_sensitivity,)


@app.cell
def _(CONST_RE, os):
    def write_back(lines: list[str], params, best_combo: tuple, path: str) -> None:
        """Update the alisp file with the best hyperparameter values."""
        for p, val in zip(params, best_combo):
            line = lines[p.line_index]
            has_newline = line.endswith("\n")
            m = CONST_RE.match(line.rstrip("\n"))
            if m:
                lines[p.line_index] = (
                    m.group(1)
                    + str(val)
                    + m.group(4)
                    + ("\n" if has_newline else "")
                )

        tmp_path = path + ".optimize.tmp"
        with open(tmp_path, "w") as f:
            f.writelines(lines)
        os.replace(tmp_path, path)

    return (write_back,)


@app.function
def print_summary(ranked, params, print_fn=print):
    """Print ranked results as a table."""
    if not ranked:
        return
    col_width = 12
    header = (
        "".join(f"{p.name:>{col_width}}" for p in params)
        + f"{'avg_score':>{col_width}}"
    )
    print_fn("\n" + header)
    print_fn("-" * len(header))
    for combo, avg in ranked[:10]:
        row = (
            "".join(f"{v:>{col_width}}" for v in combo)
            + f"{avg:>{col_width}.1f}"
        )
        print_fn(row)
    print_fn(f"\nBest combo (avg score {ranked[0][1]:.1f}):")
    for p, v in zip(params, ranked[0][0]):
        print_fn(f"  (const {p.name} {v})")


@app.function
def print_sensitivity(sensitivity, print_fn=print):
    """Print parameter sensitivity analysis."""
    if not sensitivity:
        return
    print_fn("\nParameter sensitivity:")
    for row in sensitivity:
        s_to_n = row.signal / row.noise if row.noise > 0 else float("inf")
        print_fn(
            f"  {row.name:20} signal={row.signal:7.1f}  noise={row.noise:7.1f}  s/n={s_to_n:6.2f}"
        )
        print_fn(
            f"    {'seed_noise':>24}={row.seed_noise:7.1f}  interaction_noise={row.interaction_noise:7.1f}"
        )
        print_fn(
            f"    {' '.join(f'{v}={m:6.1f}' for v, m in zip(row.values, row.means))}"
        )


@app.cell
def _(
    argparse,
    build_search_space,
    compute_sensitivity,
    mo,
    os,
    parse_annotations,
    run_sweep,
    sys,
    write_back,
):
    """CLI mode: Parse args, run sweep, print results, optionally write back."""

    is_script = mo.app_meta().mode == "script"

    if not is_script:
        # In interactive mode, this cell returns None and skips execution
        pass
    else:
        # In CLI mode, run everything and exit
        try:
            # Parse arguments
            _parser = argparse.ArgumentParser(
                prog="optimize.py",
                description="Optimize alisp hyperparameters with @hp annotations",
            )
            _parser.add_argument("file", metavar="file.alisp")
            _parser.add_argument(
                "-m",
                "--map",
                dest="map_filter",
                default=None,
                help="Map filter prefix",
            )
            _parser.add_argument(
                "-o",
                "--relax-ops",
                action="store_true",
                help="Use relaxed op limit",
            )
            _parser.add_argument(
                "-s",
                "--seeds",
                type=int,
                default=1,
                help="Number of seeds (default: 1)",
            )
            _parser.add_argument(
                "--seed-start",
                type=int,
                default=42,
                help="First seed (default: 42)",
            )
            _parser.add_argument(
                "-j",
                "--jobs",
                type=int,
                default=8,
                help="Parallel workers (default: 8)",
            )
            _parser.add_argument(
                "--write",
                action="store_true",
                help="Write best combo back to file",
            )
            _parser.add_argument(
                "--params",
                nargs="+",
                metavar="NAME",
                default=None,
                help="Only sweep these parameters (others are pinned to current value)",
            )
            _args = _parser.parse_args()

            # Resolve file path
            _filepath = _args.file
            if not _filepath.startswith("programs/"):
                _filepath = os.path.join("programs", _filepath)
            if not os.path.exists(_filepath):
                print(f"error: {_filepath} not found", file=sys.stderr)
                sys.exit(1)

            # Parse annotations
            _lines, _all_params = parse_annotations(_filepath)
            if not _all_params:
                print("error: no @hp annotations found", file=sys.stderr)
                sys.exit(1)

            # Split into swept vs pinned based on --params filter
            if _args.params is not None:
                _unknown = set(_args.params) - {p.name for p in _all_params}
                if _unknown:
                    print(f"error: unknown params: {', '.join(sorted(_unknown))}", file=sys.stderr)
                    sys.exit(1)
                _params = [p for p in _all_params if p.name in _args.params]
                _cli_pinned = [(p.name, p.current_val) for p in _all_params if p.name not in _args.params]
            else:
                _params = _all_params
                _cli_pinned = []

            # Build search space
            _combos = build_search_space(_params)
            _seeds = list(range(_args.seed_start, _args.seed_start + _args.seeds))

            print(f"\n{'=' * 70}")
            print(f"Hyperparameter Optimizer")
            print(f"{'=' * 70}")
            print(f"File: {_filepath}")
            print(f"Parameters: {len(_params)}")
            if _cli_pinned:
                print(f"Pinned: {', '.join(f'{n}={v}' for n, v in _cli_pinned)}")
            print(f"Combinations: {len(_combos)}")
            print(
                f"Seeds: {len(_seeds)} (from {_args.seed_start} to {_args.seed_start + _args.seeds - 1})"
            )
            print(f"Total jobs: {len(_combos) * len(_seeds)}")
            if _args.map_filter:
                print(f"Map filter: {_args.map_filter}")
            if _args.relax_ops:
                print(f"Op limit: 1000 (relaxed)")
            print(f"{'=' * 70}\n")

            # Run sweep
            _project_root = os.path.dirname(os.path.abspath(__file__))
            _results = run_sweep(
                _params,
                _combos,
                _seeds,
                _filepath,
                _project_root,
                _args.map_filter,
                _args.relax_ops,
                _args.jobs,
                print_fn=print,
                pinned_params=_cli_pinned,
            )

            # Analyze results
            _ranked = average_scores(_results, _params)
            if not _ranked:
                print("error: all runs failed", file=sys.stderr)
                sys.exit(1)

            _sensitivity = compute_sensitivity(_results, _params)

            # Print summaries
            print_summary(_ranked, _params, print_fn=print)
            print_sensitivity(_sensitivity, print_fn=print)

            # Write back if requested
            if _args.write:
                _best_combo = _ranked[0][0]
                _best_avg = _ranked[0][1]
                write_back(_lines, _params, _best_combo, _filepath)
                print(f"\n✓ Wrote best combo (avg {_best_avg:.1f}) to {_filepath}")

            print("\n" + "=" * 70)
            sys.exit(0)

        except Exception as e:
            print(f"error: {e}", file=sys.stderr)
            sys.exit(1)
    return


@app.cell
def _(mo):
    mo.md("""
    # Hyperparameter Optimizer
    """)
    return


@app.cell
def _(mo):
    """Persistent state for sweep results — survives upstream changes."""

    get_sweep_results, set_sweep_results = mo.state(None)
    return get_sweep_results, set_sweep_results


@app.cell
def _(mo, os, sys):
    """Refresh button, CLI arg, and selected-file state."""

    refresh_button = mo.ui.run_button(label="🔄 Refresh")

    _cli_file = None
    if "--" in sys.argv:
        _cli_args = sys.argv[sys.argv.index("--") + 1 :]
        if _cli_args:
            _cli_file = _cli_args[0]
            if _cli_file and not _cli_file.startswith("programs/"):
                _cli_file = os.path.join("programs", _cli_file)

    get_selected, set_selected = mo.state(_cli_file)
    return get_selected, refresh_button, set_selected


@app.cell
def _(get_selected, mo, os, refresh_button, set_selected):
    """File picker dropdown — re-scans programs/ when refresh is clicked."""

    _ = refresh_button.value

    _programs_dir = os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "programs"
    )
    _options = sorted(
        f"programs/{_f}"
        for _f in os.listdir(_programs_dir)
        if _f.endswith(".alisp") and ".unit." not in _f and ".inc." not in _f
    )

    _current = get_selected()
    _initial = (
        _current if _current in _options else (_options[0] if _options else None)
    )

    file_dropdown = mo.ui.dropdown(
        options=_options,
        value=_initial,
        label="File",
        on_change=set_selected,
    )
    mo.hstack([file_dropdown, refresh_button], justify="start", gap=1)
    return (file_dropdown,)


@app.cell
def _(file_dropdown, parse_annotations):
    """Load the selected file and parse its annotations."""

    filepath = file_dropdown.value
    lines, all_params = [], []
    if filepath:
        lines, all_params = parse_annotations(filepath)
    return all_params, filepath, lines


@app.cell
def _(HyperParam, all_params, mo):
    """Editable parameter table — toggle inclusion and override min/max/step."""

    param_form = None
    if all_params:
        _elements = {}
        for _p in all_params:
            _elements[f"{_p.name}__enabled"] = mo.ui.checkbox(value=True)
            _elements[f"{_p.name}__val"] = mo.ui.number(
                value=_p.current_val, label="", start=0, stop=9999, step=1
            )
            _elements[f"{_p.name}__min"] = mo.ui.number(
                value=_p.min_val, label="", start=0, stop=9999, step=1
            )
            _elements[f"{_p.name}__max"] = mo.ui.number(
                value=_p.max_val, label="", start=0, stop=9999, step=1
            )
            _elements[f"{_p.name}__step"] = mo.ui.number(
                value=_p.step, label="", start=1, stop=9999, step=1
            )

        _header = "| Sweep | Parameter | Value | Min | Max | Step |\n|---|---|---|---|---|---|\n"
        _rows_md = ""
        for _p in all_params:
            _n = _p.name
            _rows_md += (
                f"| {{{_n}__enabled}} | **{_n}** | {{{_n}__val}} "
                f"| {{{_n}__min}} | {{{_n}__max}} | {{{_n}__step}} |\n"
            )
        param_form = mo.md(_header + _rows_md).batch(**_elements)

    param_form
    return (param_form,)


@app.cell
def _(HyperParam, all_params, count_search_space, param_form):
    """Filter params based on form selection and build search space with overrides.

    Checked params are swept; unchecked params are pinned to their Value.
    Only computes the combo count here — the full list is materialized lazily
    in the sweep cell to avoid CPU spin on large search spaces.
    """

    params = []
    combo_count = 0
    pinned_params: list[tuple[str, int]] = []
    pinned_params_full: list[HyperParam] = []
    if param_form is not None and param_form.value:
        _vals = param_form.value
        for _p in all_params:
            if _vals.get(f"{_p.name}__enabled", False):
                _min = int(_vals.get(f"{_p.name}__min", _p.min_val))
                _max = int(_vals.get(f"{_p.name}__max", _p.max_val))
                _step = int(_vals.get(f"{_p.name}__step", _p.step))
                _cur = int(_vals.get(f"{_p.name}__val", _p.current_val))
                params.append(
                    HyperParam(_p.name, _min, _max, _step, _p.line_index, _cur)
                )
            else:
                _val = int(_vals.get(f"{_p.name}__val", _p.current_val))
                pinned_params.append((_p.name, _val))
                pinned_params_full.append(
                    HyperParam(_p.name, _p.min_val, _p.max_val, _p.step, _p.line_index, _val)
                )
        combo_count = count_search_space(params)
    return combo_count, params, pinned_params, pinned_params_full


@app.cell
def _(combo_count, mo, params, pinned_params, seeds_slider):
    """Show search space summary."""

    _output = None
    if params:
        _total_jobs = combo_count * seeds_slider.value
        _details = ", ".join(
            f"{p.name}={len(range(p.min_val, p.max_val + 1, p.step))}"
            for p in params
        )
        _pinned_str = ""
        if pinned_params:
            _pinned_str = "  \nPinned: " + ", ".join(
                f"{name}={val}" for name, val in pinned_params
            )
        _warn = ""
        if combo_count > 100_000:
            _warn = f"\n\n⚠️ **Very large search space** ({combo_count:,} combos). Consider reducing ranges or increasing step sizes."
        _output = mo.md(
            f"**{len(params)} parameters** ({_details}) × "
            f"**{combo_count:,} combinations** × "
            f"**{seeds_slider.value} seed(s)** = **{_total_jobs:,} total jobs**"
            f"{_pinned_str}{_warn}"
        )
    _output
    return


@app.cell
def _(mo):
    """Configuration sliders."""

    mo.md("## Configuration")
    seeds_slider = mo.ui.slider(1, 8, value=4, label="Seeds", step=1)
    seed_start_input = mo.ui.number(value=42, label="Seed start")
    jobs_slider = mo.ui.slider(1, 16, value=8, label="Parallel jobs", step=1)
    map_filter_input = mo.ui.text(value="", label="Map filter (blank = all)")
    relax_ops_checkbox = mo.ui.checkbox(
        value=False, label="Relax ops limit (-o 1000)"
    )

    mo.hstack(
        [
            mo.vstack([seeds_slider, seed_start_input]),
            mo.vstack(
                [jobs_slider, mo.vstack([map_filter_input, relax_ops_checkbox])]
            ),
        ]
    )
    return (
        jobs_slider,
        map_filter_input,
        relax_ops_checkbox,
        seed_start_input,
        seeds_slider,
    )


@app.cell
def _(combo_count, mo, params, seeds_slider):
    """Run button."""

    _total_jobs = combo_count * seeds_slider.value if params else 0
    run_button = mo.ui.run_button(label=f"Run sweep ({_total_jobs:,} jobs)")
    run_button
    return (run_button,)


@app.cell
def _(
    build_search_space,
    combo_count,
    filepath,
    jobs_slider,
    map_filter_input,
    mo,
    os,
    params,
    pinned_params,
    pinned_params_full,
    relax_ops_checkbox,
    run_button,
    run_sweep,
    seed_start_input,
    seeds_slider,
    set_sweep_results,
):
    """Execute the sweep when button is clicked.

    Results are stored in mo.state so they persist when upstream UI changes.
    Combos are only materialized here, not in the reactive dependency chain.
    """

    mo.stop(not run_button.value)

    # Materialize combos only when actually running the sweep
    combos = build_search_space(params)

    project_root = os.path.dirname(os.path.abspath(__file__))
    map_filter = map_filter_input.value or None
    relax_ops = relax_ops_checkbox.value
    seeds = list(
        range(
            int(seed_start_input.value),
            int(seed_start_input.value) + seeds_slider.value,
        )
    )
    _total = combo_count * len(seeds)

    with mo.status.progress_bar(
        total=_total,
        title="Running sweep",
        completion_title="Sweep complete",
        remove_on_exit=True,
    ) as _bar:
        _results = run_sweep(
            params,
            combos,
            seeds,
            filepath,
            project_root,
            map_filter,
            relax_ops,
            int(jobs_slider.value),
            print_fn=lambda x: None,
            progress_bar=_bar,
            pinned_params=pinned_params,
        )

    # Store results + snapshot of params/filepath used for this sweep
    set_sweep_results({
        "results": _results,
        "params": list(params),
        "pinned_params_full": list(pinned_params_full),
        "filepath": filepath,
    })
    return


@app.cell
def _(compute_sensitivity, get_sweep_results, pl):
    """Compute ranked results, sensitivity, and results dataframe.

    Reads from mo.state so charts persist when upstream UI changes.
    """

    _sweep = get_sweep_results()
    _results = _sweep["results"] if _sweep else []
    sweep_params = _sweep["params"] if _sweep else []
    sweep_pinned_full = _sweep["pinned_params_full"] if _sweep else []
    sweep_filepath = _sweep["filepath"] if _sweep else None

    ranked = average_scores(_results, sweep_params) if _results else []
    sensitivity = compute_sensitivity(_results, sweep_params) if _results else []

    # Build a polars DataFrame from raw results for charting
    results_df = pl.DataFrame()
    if _results:
        _rows = []
        for _r in _results:
            if _r.score is not None:
                _row = {sweep_params[_i].name: _r.combo[_i] for _i in range(len(sweep_params))}
                _row["seed"] = _r.seed
                _row["score"] = _r.score
                _rows.append(_row)
        if _rows:
            results_df = pl.DataFrame(_rows)
    return ranked, results_df, sensitivity, sweep_params, sweep_pinned_full, sweep_filepath


@app.cell
def _(mo, sweep_params, pl, ranked):
    """Display top results as a table."""

    _result = None
    write_button = (
        mo.ui.run_button(label="Write best values to file") if ranked else None
    )
    if ranked:
        df_top = pl.DataFrame(
            [
                {
                    **{sweep_params[i].name: combo[i] for i in range(len(sweep_params))},
                    "avg_score": avg,
                }
                for combo, avg in ranked[:10]
            ]
        )
        _result = mo.vstack(
            [mo.md("## Top Results"), mo.ui.table(df_top), write_button]
        )
    _result
    return (write_button,)


@app.cell
def _(mo, ranked, sweep_filepath, sweep_params, sweep_pinned_full, write_back, write_button):
    """Handle write-back when button is clicked.

    Writes both the best swept combo AND any manually-overridden pinned values.
    Uses the params/filepath snapshot from the sweep that produced the results.
    Re-reads the file fresh to get current line contents.
    """

    _output = None
    if write_button and write_button.value and sweep_filepath:
        _lines = open(sweep_filepath).readlines()
        best_combo, best_avg = ranked[0]
        # Write swept params with best combo values, plus pinned overrides
        all_write_params = list(sweep_params) + list(sweep_pinned_full)
        all_write_vals = tuple(best_combo) + tuple(p.current_val for p in sweep_pinned_full)
        write_back(_lines, all_write_params, all_write_vals, sweep_filepath)
        _output = mo.md(
            f"✓ **Wrote best combo** (avg score: {best_avg:.1f}) to `{sweep_filepath}`"
        )
    _output
    return


@app.cell
def _(alt, mo, sweep_params, pl, results_df):
    """Per-parameter score charts with mean, min, max."""

    _result = None
    if len(results_df) > 0 and sweep_params:
        _charts = []
        for _param in sweep_params:
            _agg = (
                results_df.group_by(_param.name)
                .agg(
                    [
                        pl.col("score").mean().alias("mean_score"),
                        pl.col("score").std().alias("std_score"),
                        pl.col("score").max().alias("max_score"),
                        pl.col("score").min().alias("min_score"),
                        pl.col("score").count().alias("n"),
                    ]
                )
                .sort(_param.name)
            )

            _base = alt.Chart(_agg).encode(
                x=alt.X(f"{_param.name}:O", title=_param.name, sort=None),
            )
            _points = _base.mark_point(
                size=80, filled=True, color="#4c78a8"
            ).encode(
                y=alt.Y(
                    "mean_score:Q", title="Score", scale=alt.Scale(zero=False)
                ),
                tooltip=[
                    alt.Tooltip(_param.name, title=_param.name),
                    alt.Tooltip("mean_score:Q", title="Mean", format=".1f"),
                    alt.Tooltip("std_score:Q", title="Std", format=".1f"),
                    alt.Tooltip("max_score:Q", title="Max"),
                    alt.Tooltip("min_score:Q", title="Min"),
                    alt.Tooltip("n:Q", title="Count"),
                ],
            )
            _ranges = _base.mark_rule(color="#333", strokeWidth=1.5).encode(
                y=alt.Y("min_score:Q"),
                y2="max_score:Q",
            )
            _chart = (_points + _ranges).properties(
                title=f"Score by {_param.name}",
                width=250,
                height=200,
            )
            _charts.append(_chart)

        _result = mo.vstack(
            [
                mo.md("## Per-Parameter Analysis"),
                mo.ui.altair_chart(alt.hconcat(*_charts)),
            ]
        )
    _result
    return


@app.cell
def _(alt, mo, sensitivity):
    """Sensitivity analysis chart: signal vs noise per parameter."""

    _result = None
    if sensitivity:
        _rows = []
        for _row in sensitivity:
            _sn = _row.signal / _row.noise if _row.noise > 0 else float("inf")
            _sn_str = f"{_sn:.2f}" if _sn != float("inf") else "inf"
            _rows.append(
                {
                    "Parameter": _row.name,
                    "Metric": "Signal",
                    "Value": _row.signal,
                    "S/N": _sn_str,
                }
            )
            _rows.append(
                {
                    "Parameter": _row.name,
                    "Metric": "Seed noise",
                    "Value": _row.seed_noise,
                    "S/N": _sn_str,
                }
            )
            _rows.append(
                {
                    "Parameter": _row.name,
                    "Metric": "Interaction noise",
                    "Value": _row.interaction_noise,
                    "S/N": _sn_str,
                }
            )

        _chart = (
            alt.Chart(alt.Data(values=_rows))
            .mark_bar()
            .encode(
                y=alt.Y("Parameter:N", sort="-x"),
                x=alt.X("Value:Q", title="Score range"),
                color=alt.Color(
                    "Metric:N",
                    scale=alt.Scale(
                        domain=["Signal", "Seed noise", "Interaction noise"],
                        range=["#4c78a8", "#f58518", "#e45756"],
                    ),
                ),
                yOffset="Metric:N",
                tooltip=[
                    alt.Tooltip("Parameter:N"),
                    alt.Tooltip("Metric:N"),
                    alt.Tooltip("Value:Q", format=".1f"),
                    alt.Tooltip("S/N:N", title="S/N ratio"),
                ],
            )
            .properties(
                title="Sensitivity: Signal vs Noise (decomposed)",
                width=400,
                height=max(len(sensitivity) * 70, 100),
            )
        )
        _result = mo.vstack(
            [
                mo.md("## Sensitivity Analysis"),
                mo.ui.altair_chart(_chart),
            ]
        )
    _result
    return


@app.cell
def _(mo, sweep_params):
    """Dropdowns to pick two parameters for interaction heatmap."""

    _result = None
    interact_x = None
    interact_y = None
    if len(sweep_params) >= 2:
        _names = [p.name for p in sweep_params]
        interact_x = mo.ui.dropdown(options=_names, value=_names[0], label="X axis")
        interact_y = mo.ui.dropdown(options=_names, value=_names[1], label="Y axis")
        _result = mo.vstack([
            mo.md("## Parameter Interaction"),
            mo.hstack([interact_x, interact_y], justify="start", gap=1),
        ])
    _result
    return interact_x, interact_y


@app.cell
def _(alt, interact_x, interact_y, mo, pl, results_df, sweep_params):
    """Heatmap showing mean score for each combination of two parameters."""

    _result = None
    if (
        interact_x is not None
        and interact_y is not None
        and interact_x.value
        and interact_y.value
        and len(results_df) > 0
        and len(sweep_params) >= 2
    ):
        _xname = interact_x.value
        _yname = interact_y.value

        if _xname != _yname:
            _agg = (
                results_df.group_by([_xname, _yname])
                .agg([
                    pl.col("score").mean().alias("mean_score"),
                    pl.col("score").std().alias("std_score"),
                    pl.col("score").count().alias("n"),
                ])
                .sort([_xname, _yname])
            )

            _heatmap = (
                alt.Chart(_agg)
                .mark_rect()
                .encode(
                    x=alt.X(f"{_xname}:O", title=_xname, sort=None),
                    y=alt.Y(f"{_yname}:O", title=_yname, sort=None),
                    color=alt.Color(
                        "mean_score:Q",
                        title="Mean Score",
                        scale=alt.Scale(scheme="viridis"),
                    ),
                    tooltip=[
                        alt.Tooltip(_xname, title=_xname),
                        alt.Tooltip(_yname, title=_yname),
                        alt.Tooltip("mean_score:Q", title="Mean", format=".1f"),
                        alt.Tooltip("std_score:Q", title="Std", format=".1f"),
                        alt.Tooltip("n:Q", title="Count"),
                    ],
                )
                .properties(
                    title=f"Mean Score: {_xname} × {_yname}",
                    width=400,
                    height=400,
                )
            )

            _text = (
                alt.Chart(_agg)
                .mark_text(fontSize=10, color="white")
                .encode(
                    x=alt.X(f"{_xname}:O", sort=None),
                    y=alt.Y(f"{_yname}:O", sort=None),
                    text=alt.Text("mean_score:Q", format=".0f"),
                )
            )

            _result = mo.ui.altair_chart(_heatmap + _text)
        else:
            _result = mo.md("*Pick two different parameters.*")
    _result
    return


if __name__ == "__main__":
    app.run()
