"""
S&P 500 Regression Analysis (multi-horizon)
-------------------------------------------
Builds regression models that explain / forecast the S&P 500's forward
returns at TWO horizons:
  - 1 month  (~next month)
  - 3 months (~next quarter)

Data source: Robert Shiller's monthly S&P 500 dataset (1871 -> present),
mirrored at github.com/datasets/s-and-p-500. This gives ~150 years of
monthly observations, which is well beyond typical equity studies.

Features engineered:
  - Trailing returns over 1m / 3m / 12m / 36m
  - Realized volatility of monthly returns over 12m / 36m
  - Drawdown from trailing peak
  - Distance from 12m and 36m moving averages
  - Shiller CAPE (PE10) -- a long-run valuation signal
  - Dividend yield (Dividend / SP500)
  - Earnings yield (Earnings / SP500)
  - Long-term interest rate (nominal)
  - Real interest rate proxy (Long Rate - trailing 12m CPI YoY)
  - CPI YoY inflation rate
  - Yield spread vs earnings yield (Fed-model style)

Outputs (under ./results/):
  - sp500_regression_report.pdf  : full visual report with all charts + summary
  - summary.txt                  : human-readable conclusions for BOTH horizons
  - ols_summary_1m.txt           : full OLS table for the 1-month model
  - ols_summary_3m.txt           : full OLS table for the 3-month model
  - coefficients_1m.csv / 3m.csv : standardized coefficients, ranked
  - predictions_1m.csv / 3m.csv  : actual vs predicted returns (out-of-sample)
  - fit_plot_1m.png / 3m.png     : actual vs predicted scatter
  - timeseries_plot.png          : SP500 (log) + drawdown
  - feature_importance_1m.png / 3m.png

Run:
    python3 sp500_regression.py
"""

from __future__ import annotations

import io
import os
import urllib.request
import warnings
from dataclasses import dataclass

import numpy as np
import pandas as pd
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.backends.backend_pdf import PdfPages
import seaborn as sns
import statsmodels.api as sm
from sklearn.linear_model import LinearRegression, Ridge
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from sklearn.preprocessing import StandardScaler

warnings.filterwarnings("ignore")

RESULTS_DIR = "results"
DATA_URL = (
    "https://raw.githubusercontent.com/datasets/s-and-p-500/master/data/data.csv"
)

HORIZONS_MONTHS = (1, 3)


@dataclass
class DataBundle:
    raw: pd.DataFrame
    features: pd.DataFrame                 # rows where ALL forward targets are observable -- for training
    features_full: pd.DataFrame            # every row with valid features -- for live scoring
    targets: dict[int, pd.Series]          # horizon (months) -> forward return series


# ---------------------------------------------------------------------------
# Data
# ---------------------------------------------------------------------------
def download_shiller() -> pd.DataFrame:
    """Pull the Shiller monthly S&P 500 dataset and tidy it up."""
    print(f"  GET {DATA_URL}")
    with urllib.request.urlopen(DATA_URL, timeout=60) as resp:
        raw = resp.read().decode("utf-8")
    df = pd.read_csv(io.StringIO(raw))
    df["Date"] = pd.to_datetime(df["Date"])
    df = df.sort_values("Date").set_index("Date")
    df = df.rename(
        columns={
            "SP500": "SPX",
            "Dividend": "DIV",
            "Earnings": "EPS",
            "Consumer Price Index": "CPI",
            "Long Interest Rate": "LONG_RATE",
            "Real Price": "REAL_SPX",
            "Real Dividend": "REAL_DIV",
            "Real Earnings": "REAL_EPS",
            "PE10": "CAPE",
        }
    )
    df = df[df["SPX"].notna()]
    # Upstream uses 0 as a sentinel for "not yet published" on the fundamentals
    # columns (so recent months show real SPX prices but zeros elsewhere).
    sentinel_zero_cols = ["DIV", "EPS", "CPI", "LONG_RATE", "CAPE"]
    for col in sentinel_zero_cols:
        if col in df.columns:
            df[col] = df[col].replace(0, np.nan)
    return df


def build_features(panel: pd.DataFrame) -> DataBundle:
    """Engineer features and the forward-return targets for each horizon."""
    df = panel.copy()
    spx = df["SPX"]

    # Trailing returns (in months, since data is monthly)
    df["ret_1m"] = spx.pct_change(1)
    df["ret_3m"] = spx.pct_change(3)
    df["ret_12m"] = spx.pct_change(12)
    df["ret_36m"] = spx.pct_change(36)

    # Volatility of monthly returns (annualized)
    df["vol_12m"] = df["ret_1m"].rolling(12).std() * np.sqrt(12)
    df["vol_36m"] = df["ret_1m"].rolling(36).std() * np.sqrt(12)

    # Drawdown and trend
    df["drawdown"] = spx / spx.cummax() - 1.0
    ma_12 = spx.rolling(12).mean()
    ma_36 = spx.rolling(36).mean()
    df["dist_ma12"] = spx / ma_12 - 1.0
    df["dist_ma36"] = spx / ma_36 - 1.0

    # Valuation
    df["log_CAPE"] = np.log(df["CAPE"])
    df["div_yield"] = df["DIV"] / df["SPX"]
    df["earn_yield"] = df["EPS"] / df["SPX"]

    # Rates & inflation
    df["cpi_yoy"] = df["CPI"].pct_change(12)
    df["real_rate"] = df["LONG_RATE"] / 100.0 - df["cpi_yoy"]
    df["fed_model_spread"] = df["earn_yield"] - df["LONG_RATE"] / 100.0

    feature_cols = [
        "ret_1m",
        "ret_3m",
        "ret_12m",
        "ret_36m",
        "vol_12m",
        "vol_36m",
        "drawdown",
        "dist_ma12",
        "dist_ma36",
        "log_CAPE",
        "div_yield",
        "earn_yield",
        "LONG_RATE",
        "cpi_yoy",
        "real_rate",
        "fed_model_spread",
    ]

    targets: dict[int, pd.Series] = {}
    for h in HORIZONS_MONTHS:
        targets[h] = spx.pct_change(h).shift(-h).rename(f"fwd_{h}m_ret")

    # Every row whose FEATURES are all finite -- used for live scoring even when
    # the forward return is not yet observable.
    features_full = df[feature_cols].dropna()

    # For training we additionally require ALL forward targets to be observable.
    training_frame = features_full.copy()
    for h in HORIZONS_MONTHS:
        training_frame = training_frame.join(targets[h])
    training_frame = training_frame.dropna()

    features = training_frame[feature_cols]
    target_series = {h: training_frame[f"fwd_{h}m_ret"] for h in HORIZONS_MONTHS}
    return DataBundle(
        raw=df,
        features=features,
        features_full=features_full,
        targets=target_series,
    )


# ---------------------------------------------------------------------------
# Modeling
# ---------------------------------------------------------------------------
def train_and_evaluate(bundle: DataBundle, horizon_months: int) -> dict:
    """Train OLS + Ridge with a chronological 80/20 split."""
    y = bundle.targets[horizon_months].values
    X = bundle.features.values
    feature_names = list(bundle.features.columns)

    split = int(len(X) * 0.8)
    X_train, X_test = X[:split], X[split:]
    y_train, y_test = y[:split], y[split:]
    idx_train = bundle.features.index[:split]
    idx_test = bundle.features.index[split:]

    scaler = StandardScaler().fit(X_train)
    Xs_train = scaler.transform(X_train)
    Xs_test = scaler.transform(X_test)

    Xs_train_c = sm.add_constant(Xs_train)
    Xs_test_c = sm.add_constant(Xs_test)
    ols = sm.OLS(y_train, Xs_train_c).fit()
    ols_pred_train = ols.predict(Xs_train_c)
    ols_pred_test = ols.predict(Xs_test_c)

    ridge = Ridge(alpha=10.0).fit(Xs_train, y_train)
    ridge_pred_test = ridge.predict(Xs_test)

    lr_raw = LinearRegression().fit(X_train, y_train)

    # Direction-accuracy: how often does the model get the SIGN right?
    sign_correct = float(np.mean(np.sign(ols_pred_test) == np.sign(y_test)))

    metrics = {
        "ols_train_r2": r2_score(y_train, ols_pred_train),
        "ols_test_r2": r2_score(y_test, ols_pred_test),
        "ols_test_mae": mean_absolute_error(y_test, ols_pred_test),
        "ols_test_rmse": float(np.sqrt(mean_squared_error(y_test, ols_pred_test))),
        "ridge_test_r2": r2_score(y_test, ridge_pred_test),
        "ridge_test_mae": mean_absolute_error(y_test, ridge_pred_test),
        "ridge_test_rmse": float(np.sqrt(mean_squared_error(y_test, ridge_pred_test))),
        "sign_accuracy_test": sign_correct,
        "n_train": int(len(y_train)),
        "n_test": int(len(y_test)),
        "train_start": str(idx_train[0].date()),
        "train_end": str(idx_train[-1].date()),
        "test_start": str(idx_test[0].date()),
        "test_end": str(idx_test[-1].date()),
    }

    coef_df = pd.DataFrame(
        {
            "feature": feature_names,
            "ols_standardized_coef": ols.params[1:],
            "ols_pvalue": ols.pvalues[1:],
            "ridge_standardized_coef": ridge.coef_,
            "raw_coef": lr_raw.coef_,
        }
    )
    coef_df["abs_std_coef"] = coef_df["ols_standardized_coef"].abs()
    coef_df = coef_df.sort_values("abs_std_coef", ascending=False).reset_index(drop=True)

    predictions = pd.DataFrame(
        {
            "date": idx_test,
            f"actual_fwd_{horizon_months}m_ret": y_test,
            "ols_pred": ols_pred_test,
            "ridge_pred": ridge_pred_test,
        }
    ).set_index("date")

    return {
        "horizon_months": horizon_months,
        "metrics": metrics,
        "coefficients": coef_df,
        "predictions": predictions,
        "ols_summary": str(ols.summary()),
        "ols_model": ols,
        "scaler": scaler,
        "feature_names": feature_names,
        "latest_features": bundle.features_full.iloc[[-1]],
        "latest_date": bundle.features_full.index[-1],
    }


def classify(pred: float, horizon_months: int) -> str:
    """Bucket a predicted return into a verdict label, scaled by horizon."""
    # Scale thresholds with horizon so 3-month bands are wider than 1-month
    big = 0.03 * horizon_months
    small = 0.005 * horizon_months
    h = f"{horizon_months}-month"
    if pred < -big:
        return f"BEARISH ({h}) — predicts a sharp drop > {big*100:.1f}%"
    if pred < -small:
        return f"MILDLY BEARISH ({h}) — predicts a small negative return"
    if pred < small:
        return f"NEUTRAL ({h}) — predicts roughly flat returns"
    if pred < big:
        return f"MILDLY BULLISH ({h}) — predicts modest positive returns"
    return f"BULLISH ({h}) — predicts a strong rally > {big*100:.1f}%"


def current_conclusion(result: dict) -> tuple[str, float]:
    ols = result["ols_model"]
    scaler = result["scaler"]
    x = scaler.transform(result["latest_features"].values)
    x = sm.add_constant(x, has_constant="add")
    pred = float(ols.predict(x)[0])
    return classify(pred, result["horizon_months"]), pred


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------
def write_plots(bundle: DataBundle, results: dict[int, dict]) -> None:
    sns.set_theme(style="whitegrid")

    # Time series of SPX (log) + drawdown
    fig, axes = plt.subplots(2, 1, figsize=(11, 7), sharex=True)
    axes[0].plot(bundle.raw.index, bundle.raw["SPX"], color="navy")
    axes[0].set_yscale("log")
    axes[0].set_title("S&P 500 (nominal, log scale) -- Shiller dataset")
    dd = bundle.raw["SPX"] / bundle.raw["SPX"].cummax() - 1.0
    axes[1].fill_between(bundle.raw.index, dd, 0, color="crimson", alpha=0.5)
    axes[1].set_title("Drawdown from trailing peak")
    axes[1].set_ylabel("Drawdown")
    fig.tight_layout()
    fig.savefig(os.path.join(RESULTS_DIR, "timeseries_plot.png"), dpi=120)
    plt.close(fig)

    for h, result in results.items():
        # Fit plot
        fig, ax = plt.subplots(figsize=(8, 6))
        preds = result["predictions"]
        actual_col = f"actual_fwd_{h}m_ret"
        ax.scatter(preds[actual_col], preds["ols_pred"], alpha=0.3, s=14)
        lim = max(abs(preds[actual_col]).max(), abs(preds["ols_pred"]).max())
        ax.plot([-lim, lim], [-lim, lim], color="red", linestyle="--", linewidth=1)
        ax.set_xlabel(f"Actual forward {h}-month return")
        ax.set_ylabel(f"OLS predicted forward {h}-month return")
        ax.set_title(f"S&P 500 -- actual vs predicted ({h}m, out-of-sample)")
        fig.tight_layout()
        fig.savefig(os.path.join(RESULTS_DIR, f"fit_plot_{h}m.png"), dpi=120)
        plt.close(fig)

        # Feature importance
        fig, ax = plt.subplots(figsize=(9, 7))
        coef_df = result["coefficients"]
        colors = [
            "seagreen" if c > 0 else "crimson"
            for c in coef_df["ols_standardized_coef"]
        ]
        ax.barh(coef_df["feature"], coef_df["ols_standardized_coef"], color=colors)
        ax.invert_yaxis()
        ax.axvline(0, color="black", linewidth=0.8)
        ax.set_xlabel("Standardized OLS coefficient")
        ax.set_title(f"Feature impact on {h}-month S&P 500 return")
        fig.tight_layout()
        fig.savefig(
            os.path.join(RESULTS_DIR, f"feature_importance_{h}m.png"), dpi=120
        )
        plt.close(fig)


def _text_page(pdf: PdfPages, title: str, body: str) -> None:
    """Render a text block as a PDF page."""
    fig, ax = plt.subplots(figsize=(8.5, 11))
    ax.axis("off")
    ax.text(0.02, 0.97, title, fontsize=16, fontweight="bold", va="top")
    ax.text(
        0.02,
        0.93,
        body,
        fontsize=9,
        family="monospace",
        va="top",
        wrap=True,
    )
    pdf.savefig(fig, bbox_inches="tight")
    plt.close(fig)


def _cover_page(pdf: PdfPages, bundle: DataBundle, results: dict[int, dict]) -> None:
    fig, ax = plt.subplots(figsize=(8.5, 11))
    ax.axis("off")
    ax.text(
        0.5, 0.92, "S&P 500 Regression Analysis",
        fontsize=22, fontweight="bold", ha="center",
    )
    ax.text(
        0.5, 0.88, "Multi-horizon forecast report (1m & 3m)",
        fontsize=13, ha="center", color="#555",
    )

    span = (
        f"Data span: {bundle.features.index.min().date()}  ->  "
        f"{bundle.features.index.max().date()}   "
        f"({len(bundle.features):,} monthly observations)"
    )
    ax.text(0.5, 0.83, span, fontsize=10, ha="center", color="#333")
    ax.text(
        0.5, 0.80,
        "Source: Robert Shiller monthly S&P 500 dataset (github.com/datasets/s-and-p-500)",
        fontsize=9, ha="center", color="#666",
    )

    # Verdict box per horizon
    y = 0.68
    for h, result in results.items():
        verdict, pred = current_conclusion(result)
        m = result["metrics"]
        ax.text(
            0.06, y,
            f"{h}-MONTH FORECAST",
            fontsize=13, fontweight="bold",
        )
        ax.text(
            0.06, y - 0.035,
            f"Predicted return:   {pred*100:+.2f}%",
            fontsize=11, family="monospace",
        )
        ax.text(
            0.06, y - 0.06,
            f"Verdict:            {verdict}",
            fontsize=11, family="monospace",
        )
        ax.text(
            0.06, y - 0.085,
            f"Out-of-sample R^2: {m['ols_test_r2']:+.4f}    "
            f"Direction accuracy: {m['sign_accuracy_test']*100:.1f}%",
            fontsize=10, family="monospace", color="#444",
        )
        y -= 0.16

    ax.text(
        0.5, 0.08,
        f"As-of feature row: {results[1]['latest_date'].date()}",
        fontsize=9, ha="center", color="#666",
    )
    pdf.savefig(fig, bbox_inches="tight")
    plt.close(fig)


def _spx_drawdown_page(pdf: PdfPages, bundle: DataBundle) -> None:
    fig, axes = plt.subplots(2, 1, figsize=(11, 7), sharex=True)
    axes[0].plot(bundle.raw.index, bundle.raw["SPX"], color="navy")
    axes[0].set_yscale("log")
    axes[0].set_title("S&P 500 (nominal, log scale) -- Shiller dataset")
    dd = bundle.raw["SPX"] / bundle.raw["SPX"].cummax() - 1.0
    axes[1].fill_between(bundle.raw.index, dd, 0, color="crimson", alpha=0.5)
    axes[1].set_title("Drawdown from trailing peak")
    axes[1].set_ylabel("Drawdown")
    fig.tight_layout()
    pdf.savefig(fig)
    plt.close(fig)


def _fit_scatter_page(pdf: PdfPages, result: dict) -> None:
    h = result["horizon_months"]
    preds = result["predictions"]
    actual_col = f"actual_fwd_{h}m_ret"
    fig, ax = plt.subplots(figsize=(8, 6))
    ax.scatter(preds[actual_col], preds["ols_pred"], alpha=0.3, s=14)
    lim = max(abs(preds[actual_col]).max(), abs(preds["ols_pred"]).max())
    ax.plot([-lim, lim], [-lim, lim], color="red", linestyle="--", linewidth=1)
    ax.set_xlabel(f"Actual forward {h}-month return")
    ax.set_ylabel(f"OLS predicted forward {h}-month return")
    ax.set_title(f"S&P 500 -- actual vs predicted ({h}m, out-of-sample)")
    fig.tight_layout()
    pdf.savefig(fig)
    plt.close(fig)


def _timeseries_pred_page(pdf: PdfPages, result: dict) -> None:
    h = result["horizon_months"]
    preds = result["predictions"]
    actual_col = f"actual_fwd_{h}m_ret"
    fig, ax = plt.subplots(figsize=(11, 5))
    ax.plot(preds.index, preds[actual_col] * 100, label="Actual", color="black", linewidth=1)
    ax.plot(preds.index, preds["ols_pred"] * 100, label="OLS predicted", color="seagreen", linewidth=1.2)
    ax.axhline(0, color="grey", linewidth=0.6)
    ax.set_ylabel("Forward return (%)")
    ax.set_title(f"S&P 500 forward {h}-month return -- actual vs predicted over time")
    ax.legend(loc="best")
    fig.tight_layout()
    pdf.savefig(fig)
    plt.close(fig)


def _feature_importance_page(pdf: PdfPages, result: dict) -> None:
    h = result["horizon_months"]
    coef_df = result["coefficients"]
    fig, ax = plt.subplots(figsize=(9, 7))
    colors = [
        "seagreen" if c > 0 else "crimson"
        for c in coef_df["ols_standardized_coef"]
    ]
    ax.barh(coef_df["feature"], coef_df["ols_standardized_coef"], color=colors)
    ax.invert_yaxis()
    ax.axvline(0, color="black", linewidth=0.8)
    ax.set_xlabel("Standardized OLS coefficient")
    ax.set_title(f"Feature impact on {h}-month S&P 500 return")
    fig.tight_layout()
    pdf.savefig(fig)
    plt.close(fig)


def write_pdf_report(
    bundle: DataBundle,
    results: dict[int, dict],
    summary_text: str,
    path: str,
) -> None:
    sns.set_theme(style="whitegrid")
    with PdfPages(path) as pdf:
        _cover_page(pdf, bundle, results)
        _spx_drawdown_page(pdf, bundle)
        for h in sorted(results):
            result = results[h]
            _feature_importance_page(pdf, result)
            _fit_scatter_page(pdf, result)
            _timeseries_pred_page(pdf, result)
            # Top-features table page
            top = result["coefficients"].head(10).copy()
            top["ols_standardized_coef"] = top["ols_standardized_coef"].map(
                lambda v: f"{v:+.4f}"
            )
            top["ols_pvalue"] = top["ols_pvalue"].map(lambda v: f"{v:.4f}")
            top["ridge_standardized_coef"] = top["ridge_standardized_coef"].map(
                lambda v: f"{v:+.4f}"
            )
            table_body = top[
                ["feature", "ols_standardized_coef", "ols_pvalue", "ridge_standardized_coef"]
            ].to_string(index=False)
            _text_page(
                pdf,
                f"Top features -- {h}-month horizon",
                table_body,
            )
        _text_page(pdf, "Full text summary", summary_text)


def write_outputs(bundle: DataBundle, results: dict[int, dict]) -> None:
    os.makedirs(RESULTS_DIR, exist_ok=True)

    for h, result in results.items():
        result["coefficients"].to_csv(
            os.path.join(RESULTS_DIR, f"coefficients_{h}m.csv"), index=False
        )
        result["predictions"].to_csv(
            os.path.join(RESULTS_DIR, f"predictions_{h}m.csv")
        )
        with open(os.path.join(RESULTS_DIR, f"ols_summary_{h}m.txt"), "w") as fh:
            fh.write(result["ols_summary"])

    write_plots(bundle, results)

    lines = []
    lines.append("S&P 500 Regression Analysis -- Summary")
    lines.append("=" * 70)
    lines.append("")
    lines.append("Data: Shiller monthly S&P 500 dataset")
    lines.append(
        f"Span: {bundle.features.index.min().date()}  ->  "
        f"{bundle.features.index.max().date()}  "
        f"({len(bundle.features):,} monthly observations)"
    )
    lines.append("")
    for h, result in results.items():
        m = result["metrics"]
        verdict, pred = current_conclusion(result)
        lines.append("-" * 70)
        lines.append(f"Forecast horizon: {h} month(s)")
        lines.append("-" * 70)
        lines.append(
            f"  Train: {m['train_start']} -> {m['train_end']} "
            f"({m['n_train']:,} obs)"
        )
        lines.append(
            f"  Test:  {m['test_start']} -> {m['test_end']} "
            f"({m['n_test']:,} obs)"
        )
        lines.append(f"  OLS   R^2 (train):     {m['ols_train_r2']:+.4f}")
        lines.append(f"  OLS   R^2 (test):      {m['ols_test_r2']:+.4f}")
        lines.append(f"  OLS   MAE (test):       {m['ols_test_mae']:.4f}")
        lines.append(f"  OLS   RMSE(test):       {m['ols_test_rmse']:.4f}")
        lines.append(f"  Ridge R^2 (test):      {m['ridge_test_r2']:+.4f}")
        lines.append(f"  Ridge MAE (test):       {m['ridge_test_mae']:.4f}")
        lines.append(f"  Direction-accuracy:    {m['sign_accuracy_test']*100:.1f}%")
        lines.append("")
        lines.append("  Top 6 features by |standardized coefficient|:")
        for _, row in result["coefficients"].head(6).iterrows():
            lines.append(
                f"    {row['feature']:<20}  "
                f"std_coef={row['ols_standardized_coef']:+.4f}  "
                f"p={row['ols_pvalue']:.4f}"
            )
        lines.append("")
        lines.append(f"  As-of: {result['latest_date'].date()}")
        lines.append(f"  Predicted {h}-month return: {pred*100:+.2f}%")
        lines.append(f"  Verdict: {verdict}")
        lines.append("")

    lines.append("Caveats")
    lines.append("-" * 70)
    lines.append("  - Equity returns are noisy; expect single-digit R^2 even with")
    lines.append("    well-known long-run predictors (CAPE, yield spreads).")
    lines.append("  - The 3-month model generally produces stronger valuation signals,")
    lines.append("    because mean-reversion in CAPE/yields plays out over quarters.")
    lines.append("  - All major historical crashes (1929, 1987, 2000, 2008, 2020) are")
    lines.append("    inside the dataset, but the model cannot predict the TIMING of")
    lines.append("    sudden shocks -- only the expected drift given today's regime.")
    lines.append("  - Features are highly collinear; individual coefficients/p-values")
    lines.append("    are interpretive guides, not causal claims.")

    summary = "\n".join(lines)
    with open(os.path.join(RESULTS_DIR, "summary.txt"), "w") as fh:
        fh.write(summary)

    pdf_path = os.path.join(RESULTS_DIR, "sp500_regression_report.pdf")
    write_pdf_report(bundle, results, summary, pdf_path)
    print(f"PDF report: {pdf_path}")

    print()
    print(summary)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
def main() -> None:
    print("Downloading Shiller S&P 500 dataset...")
    panel = download_shiller()
    print(
        f"  rows: {len(panel):,}  range: {panel.index.min().date()} -> "
        f"{panel.index.max().date()}"
    )

    print("Building features and targets...")
    bundle = build_features(panel)
    print(
        f"  feature matrix: {bundle.features.shape}  "
        f"horizons: {list(bundle.targets.keys())} months"
    )

    print("Training and evaluating models...")
    results: dict[int, dict] = {}
    for h in HORIZONS_MONTHS:
        print(f"  fitting horizon = {h} month(s)...")
        results[h] = train_and_evaluate(bundle, h)

    print("Writing outputs...")
    write_outputs(bundle, results)
    print(f"\nDone. Results written to ./{RESULTS_DIR}/")


if __name__ == "__main__":
    main()
