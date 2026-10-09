// Model state (spec §2a "Model priors", brief §5). The adaptive TDEE estimate
// starts from the prior (13.2 kcal/lb × trend + cardio) and moves toward
// observed data as weigh-ins accrue. This module only builds the seed; the
// estimator itself lands with the coach scripts (stage 6).
import { trendFromEntries, round1 } from './trend.js';

export const MODEL_SCHEMA_VERSION = 1;

export function seedModelState(profile, { weighins, phases, generatedUtc }) {
  const p = profile.priors;
  const t = profile.targets;
  const r = profile.adjustment_rules;
  const series = trendFromEntries(weighins, r.trend.half_life_days);
  const last = series[series.length - 1] || null;
  const baseKcal = last ? Math.round(p.maintenance_kcal_per_lb.mean * last.trend) : null;
  return {
    schema_version: MODEL_SCHEMA_VERSION,
    generated_utc: generatedUtc,
    source: 'data/metabolic_profile.json',
    priors: {
      base_kcal_per_lb: p.maintenance_kcal_per_lb.mean,
      base_sd_kcal: p.maintenance_kcal_per_lb.sd_kcal,
      base_kcal_per_lb_range: p.maintenance_kcal_per_lb.on_plan_range,
      kcal_per_lb: { loss: p.kcal_per_lb_change.loss, gain: p.kcal_per_lb_change.gain },
      cardio: {
        stairs_net_met: p.cardio_model.stairs_net_met,
        stairs_kcal_per_min_median_watch: p.cardio_model.stairs_kcal_per_min_median_watch,
        run_kcal_per_km: p.cardio_model.run_kcal_per_km,
        kcal_per_min_formula: p.cardio_model.kcal_per_min_formula,
      },
      glycogen_washout_days: p.glycogen_washout_days_after_carb_change,
    },
    rate_bands_pct_bw_per_wk: {
      cut: { target: t.cut_rate_pct_bw_per_wk.target, slow_limit: t.cut_rate_pct_bw_per_wk.min_loss, cap: t.cut_rate_pct_bw_per_wk.max_loss },
      bulk: { target: t.gain_rate_pct_bw_per_wk.target, cap: t.gain_rate_pct_bw_per_wk.max },
      maintenance: { target: [-0.1, 0.1] },
    },
    macro_floors: {
      protein_g_per_lb_min: 1.0,
      protein_g_per_lb: t.protein_g_per_lb,
      fat_g_per_lb_min: t.fat_floor_g_per_lb,
      fat_g_min_abs: t.fat_floor_g_abs,
      fat_g_target_min: 50,
    },
    adjustment: {
      step_kcal: r.step_kcal,
      max_weekly_change_kcal: r.max_weekly_tdee_estimate_change_kcal,
      tdee_window_days: r.tdee_window_days,
      min_weigh_ins_in_window: r.min_weigh_ins_in_window,
      observed_weight: { weighins_divisor: 30, cap: 0.85 }, // w = min(0.85, n / 30)
      consecutive_off_target_checkins: r.consecutive_off_target_checkins_before_change,
    },
    trend: {
      half_life_days: r.trend.half_life_days,
      last_local_date: last ? last.date : null,
      last_weight_lb: last ? last.weight : null,
      trend_lb: last ? round1(last.trend) : null,
    },
    tdee: {
      method: 'prior',
      base_kcal: baseKcal,
      cardio_kcal: 0,
      estimate_kcal: baseKcal,
      weight_on_observed: 0,
      updated_local_date: last ? last.date : null,
    },
    phase_history: phases.map(({ id, kind, label, start, end }) => ({ id, kind, label, start, end })),
    progression: {},
    last_daily_run_local_date: null,
    last_weekly_run_week: null,
  };
}
