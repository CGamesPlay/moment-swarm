import marimo

__generated_with = "0.19.7"
app = marimo.App(width="full")


@app.cell
def _():
    import marimo as mo
    import polars as pl
    import altair as alt
    import subprocess
    import os
    import re
    from itertools import product
    from concurrent.futures import ThreadPoolExecutor, as_completed
    return (
        ThreadPoolExecutor,
        alt,
        as_completed,
        mo,
        os,
        pl,
        product,
        re,
        subprocess,
    )


@app.cell
def _(mo):
    mo.md("""
    # Hyperparameter Sweep Dashboard
    """)
    return


@app.cell
def _(mo):
    mo.md("""
    ## Run Sweep

    Define parameters as `NAME=val1,val2,val3` (one per line). All combinations will be tested in parallel.
    """)
    return


@app.cell
def _(mo, os):
    _alisp_files = sorted(
        f
        for f in os.listdir(".")
        if f.endswith(".alisp") and not f.endswith(".unit.alisp")
    )
    sweep_file = mo.ui.dropdown(
        options=_alisp_files,
        value=_alisp_files[0] if _alisp_files else None,
        label="Alisp file",
    )
    sweep_map = mo.ui.text(value="", label="Map filter (blank = all)")
    sweep_params = mo.ui.text_area(
        value="EXPLORE_TIMEOUT=200,300,400\nTRAIL_STRENGTH=100,125,150\nSCAN_STEPS=25,30,35",
        label="Parameters (NAME=val1,val2,...)",
        full_width=True,
    )
    sweep_parallel = mo.ui.slider(1, 16, value=8, label="Parallel jobs", step=1)
    mo.hstack(
        [
            mo.vstack([sweep_file, sweep_map, sweep_parallel]),
            sweep_params,
        ]
    )
    return sweep_file, sweep_map, sweep_parallel, sweep_params


@app.cell
def _(product, sweep_params):
    # Parse parameter definitions
    sweep_names = []
    sweep_value_lists = []
    for _line in sweep_params.value.strip().splitlines():
        _line = _line.strip()
        if not _line or "=" not in _line:
            continue
        _name, _vals_str = _line.split("=", 1)
        sweep_names.append(_name.strip())
        sweep_value_lists.append([v.strip() for v in _vals_str.split(",")])

    sweep_combos = list(product(*sweep_value_lists)) if sweep_names else []
    return sweep_combos, sweep_names


@app.cell
def _(mo, sweep_combos, sweep_file, sweep_names, sweep_parallel):
    if len(sweep_combos) == 0:
        sweep_run_button = mo.ui.run_button(label="Run sweep", disabled=True)
        mo.output.replace(mo.md("*Configure parameters above to run a sweep.*"))
    else:
        sweep_run_button = mo.ui.run_button(
            label=f"Run sweep ({len(sweep_combos)} combinations)"
        )
        mo.output.replace(
            mo.vstack(
                [
                    mo.md(
                        f"**{len(sweep_combos)} combinations** across {len(sweep_names)} parameters, {sweep_parallel.value} parallel jobs on `{sweep_file.value}`"
                    ),
                    sweep_run_button,
                ]
            )
        )
    return (sweep_run_button,)


@app.cell
def _(
    ThreadPoolExecutor,
    as_completed,
    mo,
    os,
    pl,
    re,
    subprocess,
    sweep_combos,
    sweep_file,
    sweep_map,
    sweep_names,
    sweep_parallel,
    sweep_run_button,
):
    sweep_df = pl.DataFrame()

    if sweep_run_button.value and len(sweep_combos) > 0:
        _project_dir = os.path.dirname(os.path.abspath(__file__))
        _map_flag = ["-m", sweep_map.value] if sweep_map.value.strip() else []

        def _run_one(_combo):
            _dflags = []
            for _i in range(len(sweep_names)):
                _dflags.extend(["-D", f"{sweep_names[_i]}={_combo[_i]}"])

            _compile_result = subprocess.run(
                ["node", "antlisp.js"] + _dflags + [sweep_file.value],
                capture_output=True,
                text=True,
                cwd=_project_dir,
            )
            if _compile_result.returncode != 0:
                return _combo, None, _compile_result.stderr.strip()

            _run_result = subprocess.run(
                ["node", "run.js"] + _map_flag,
                input=_compile_result.stdout,
                capture_output=True,
                text=True,
                cwd=_project_dir,
            )

            _match = re.search(r"^Score:\s*(\d+)", _run_result.stdout, re.MULTILINE)
            if _match:
                return _combo, int(_match.group(1)), None
            return _combo, None, _run_result.stdout + _run_result.stderr

        _results = []
        _errors = []
        with mo.status.progress_bar(
            total=len(sweep_combos), title="Running sweep"
        ) as _bar:
            with ThreadPoolExecutor(max_workers=sweep_parallel.value) as _pool:
                _futures = {_pool.submit(_run_one, _c): _c for _c in sweep_combos}
                for _future in as_completed(_futures):
                    _combo, _score, _err = _future.result()
                    if _score is not None:
                        _row = {
                            sweep_names[_i]: _combo[_i]
                            for _i in range(len(sweep_names))
                        }
                        _row["score"] = _score
                        _results.append(_row)
                    else:
                        _errors.append((_combo, _err))
                    _bar.update()

        sweep_df = pl.DataFrame(_results)
        for _col in sweep_names:
            try:
                sweep_df = sweep_df.with_columns(pl.col(_col).cast(pl.Int64))
            except Exception:
                try:
                    sweep_df = sweep_df.with_columns(pl.col(_col).cast(pl.Float64))
                except Exception:
                    pass

        _parts = [
            mo.md(
                f"**Sweep complete:** {len(_results)} succeeded, {len(_errors)} failed"
            )
        ]
        if _errors:
            _err_lines = [f"- `{_c}`: {_e.replace("\n", "\n  ")}" for _c, _e in _errors[:5]]
            _parts.append(mo.md("**Errors:**\n" + "\n".join(_err_lines)))
        mo.output.replace(mo.vstack(_parts))

        sweep_csv = sweep_df.write_csv()
    else:
        sweep_csv = ""
    return (sweep_csv,)


@app.cell
def _(mo):
    mo.md("""
    ## CSV Data

    Sweep results appear here automatically. Paste previous results or edit as needed.
    """)
    return


@app.cell
def _(mo, sweep_csv):
    csv_input = mo.ui.text_area(
        value=sweep_csv,
        label="CSV data",
        full_width=True,
    )
    csv_input
    return (csv_input,)


@app.cell
def _(csv_input, mo, pl):
    import io as _io

    mo.stop(
        not csv_input.value.strip(), mo.md("*Run a sweep or paste CSV data to begin.*")
    )

    df = pl.read_csv(_io.StringIO(csv_input.value.strip()))
    score_col = "score"
    param_cols = [c for c in df.columns if c != score_col]
    mo.md(
        f"**Loaded {len(df)} rows** with params: `{'`, `'.join(param_cols)}` and score column: `{score_col}`"
    )
    return df, param_cols, score_col


@app.cell
def _(mo):
    mo.md("""
    ## Overview
    """)
    return


@app.cell
def _(df, mo, param_cols, score_col):
    best_row = df.sort(score_col, descending=True).head(1)
    worst_row = df.sort(score_col).head(1)
    scores = df[score_col]

    stats_md = f"""
    | Metric | Value |
    |--------|-------|
    | **Best score** | {scores.max()} |
    | **Worst score** | {scores.min()} |
    | **Mean score** | {scores.mean():.1f} |
    | **Std dev** | {scores.std():.1f} |
    | **Score range** | {scores.max() - scores.min()} |
    | **Num combinations** | {len(df)} |
    """

    best_params = ", ".join(f"`{c}={best_row[c].item()}`" for c in param_cols)

    mo.vstack(
        [
            mo.md(stats_md),
            mo.md(f"**Best combo:** {best_params} → **{best_row[score_col].item()}**"),
        ]
    )
    return


@app.cell
def _(mo):
    mo.md("""
    ## Per-Parameter Analysis
    """)
    return


@app.cell
def _(alt, df, mo, param_cols, pl, score_col):
    _charts = []
    for _param in param_cols:
        _param_agg = (
            df.group_by(_param)
            .agg(
                [
                    pl.col(score_col).mean().alias("mean_score"),
                    pl.col(score_col).std().alias("std_score"),
                    pl.col(score_col).max().alias("max_score"),
                    pl.col(score_col).min().alias("min_score"),
                    pl.col(score_col).count().alias("n"),
                ]
            )
            .sort(_param)
        )

        _base = alt.Chart(_param_agg).encode(
            x=alt.X(f"{_param}:O", title=_param, sort=None),
        )
        _points = _base.mark_point(size=80, filled=True, color="#4c78a8").encode(
            y=alt.Y("mean_score:Q", title="Score", scale=alt.Scale(zero=False)),
            tooltip=[
                alt.Tooltip(_param, title=_param),
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
            title=f"Score by {_param}",
            width=250,
            height=200,
        )
        _charts.append(_chart)

    mo.ui.altair_chart(alt.hconcat(*_charts))
    return


@app.cell
def _(mo):
    mo.md("""
    ## Interaction Effects
    """)
    return


@app.cell
def _(alt, df, mo, param_cols, pl, score_col):
    mo.stop(len(param_cols) < 2, mo.md("*Need at least 2 parameters for heatmaps.*"))

    _grand_mean = df[score_col].mean()
    # Marginal means for each parameter value
    _marginal = {}
    for _p in param_cols:
        _marginal[_p] = dict(
            df.group_by(_p).agg(pl.col(score_col).mean().alias("m")).iter_rows()
        )

    _heatmaps = []
    for _i, _p1 in enumerate(param_cols):
        for _p2 in param_cols[_i + 1 :]:
            # Interaction = cell_mean - marginal_p1 - marginal_p2 + grand_mean
            _heat_df = df.group_by([_p1, _p2]).agg(
                pl.col(score_col).mean().alias("mean_score")
            )
            _heat_df = _heat_df.with_columns(
                (
                    pl.col("mean_score")
                    - pl.col(_p1).map_elements(
                        lambda v, _m=_marginal[_p1]: _m[v], return_dtype=pl.Float64
                    )
                    - pl.col(_p2).map_elements(
                        lambda v, _m=_marginal[_p2]: _m[v], return_dtype=pl.Float64
                    )
                    + _grand_mean
                ).alias("interaction")
            )

            _max_abs = max(
                abs(_heat_df["interaction"].min()),
                abs(_heat_df["interaction"].max()),
                0.1,
            )

            _hm = (
                alt.Chart(_heat_df)
                .mark_rect()
                .encode(
                    x=alt.X(f"{_p1}:O", title=_p1),
                    y=alt.Y(f"{_p2}:O", title=_p2),
                    color=alt.Color(
                        "interaction:Q",
                        title="Interaction",
                        scale=alt.Scale(
                            scheme="redblue", domain=[-_max_abs, _max_abs], reverse=True
                        ),
                    ),
                    tooltip=[
                        alt.Tooltip(_p1, title=_p1),
                        alt.Tooltip(_p2, title=_p2),
                        alt.Tooltip(
                            "interaction:Q", title="Interaction", format="+.1f"
                        ),
                        alt.Tooltip("mean_score:Q", title="Mean Score", format=".1f"),
                    ],
                )
                .properties(
                    title=f"{_p1} × {_p2}",
                    width=250,
                    height=200,
                )
            )
            _text = (
                alt.Chart(_heat_df)
                .mark_text(fontSize=11)
                .encode(
                    x=alt.X(f"{_p1}:O"),
                    y=alt.Y(f"{_p2}:O"),
                    text=alt.Text("interaction:Q", format="+.1f"),
                    color=alt.condition(
                        alt.datum.interaction > 0,
                        alt.value("white"),
                        alt.value("black"),
                    ),
                )
            )
            _heatmaps.append(_hm + _text)

    mo.ui.altair_chart(alt.hconcat(*_heatmaps))
    return


@app.cell
def _(mo):
    mo.md("""
    ## Suggest Next Sweep

    Configure the search to find promising regions for the next experiment.
    """)
    return


@app.cell
def _(df, mo, param_cols, pl, product, score_col):
    # Analyze which parameter values appear in top runs
    _top_frac = 0.25
    _n_top = max(1, int(len(df) * _top_frac))
    _top_df = df.sort(score_col, descending=True).head(_n_top)

    _suggestions = {}
    for _param in param_cols:
        _all_vals = sorted(df[_param].unique().to_list())
        _top_vals = _top_df[_param].to_list()

        # Count how often each value appears in top runs
        _val_counts = {}
        for _v in _all_vals:
            _val_counts[_v] = _top_vals.count(_v)

        # Find the best-performing value
        _best_val = max(_val_counts, key=_val_counts.get)
        _best_idx = _all_vals.index(_best_val)

        # Suggest exploring around the best value
        _suggested = set()
        _suggested.add(_best_val)

        # Add neighbors in the existing grid
        if _best_idx > 0:
            _suggested.add(_all_vals[_best_idx - 1])
        if _best_idx < len(_all_vals) - 1:
            _suggested.add(_all_vals[_best_idx + 1])

        # Add midpoints between existing values
        if len(_all_vals) >= 2:
            _midpoints = set()
            for _j in range(len(_all_vals) - 1):
                _mid = (_all_vals[_j] + _all_vals[_j + 1]) / 2
                # Only add if it's a "nice" number (integer or simple fraction)
                if _mid == int(_mid):
                    _midpoints.add(int(_mid))
            _suggested.update(_midpoints)

        _suggestions[_param] = sorted(_suggested)

    # Generate the suggested sweep grid
    _sweep_combos = list(product(*[_suggestions[_p] for _p in param_cols]))

    # Filter out already-tested combinations
    _tested = set()
    for _row in df.iter_rows(named=True):
        _tested.add(tuple(_row[_p] for _p in param_cols))
    _new_combos = [_c for _c in _sweep_combos if _c not in _tested]

    _sweep_df = (
        pl.DataFrame([dict(zip(param_cols, _combo)) for _combo in _new_combos])
        if _new_combos
        else pl.DataFrame()
    )

    _parts = []
    _parts.append(mo.md("### Analysis of Top Performers"))

    for _param in param_cols:
        _all_vals = sorted(df[_param].unique().to_list())
        # Mean score per value
        _means = (
            df.group_by(_param)
            .agg(pl.col(score_col).mean().alias("mean"))
            .sort("mean", descending=True)
        )
        _best_param_val = _means[_param][0]
        _best_mean = _means["mean"][0]
        _parts.append(
            mo.md(
                f"- **{_param}**: best mean score at `{_best_param_val}` ({_best_mean:.1f}), suggest exploring: `{_suggestions[_param]}`"
            )
        )

    _parts.append(mo.md(f"### Suggested Next Sweep"))
    _parts.append(
        mo.md(
            f"**{len(_new_combos)} untested combinations** from refining around top performers:"
        )
    )

    if len(_sweep_df) > 0:
        _parts.append(mo.ui.table(_sweep_df))

    # Generate CSV for easy copy-paste
    if len(_new_combos) > 0:
        _csv_lines = [",".join(param_cols)]
        for _combo in _new_combos:
            _csv_lines.append(",".join(str(_v) for _v in _combo))
        _sweep_csv = "\n".join(_csv_lines)
        _parts.append(mo.md(f"### CSV for next sweep\n```\n{_sweep_csv}\n```"))

    mo.vstack(_parts)
    return


@app.cell
def _(mo):
    mo.md("""
    ## Raw Data Explorer
    """)
    return


@app.cell
def _(df, mo):
    mo.ui.dataframe(df)
    return


if __name__ == "__main__":
    app.run()
